import { Context } from '@deepseek-ai/cordis'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { ContextDelegationError, ContextDelegationService } from '../src/index.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'

function makeResult(stopReason: SubagentResult['stopReason'], diagnostic: string): SubagentResult {
  return {
    stopReason,
    diagnostic,
    output: [{ type: 'text', text: 'partial text from provider' }],
  }
}

function makeEnvironment(start: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun>) {
  const ctx = new Context()
  const fs = new RecordingFileSystem(ctx)
  ctx.fs = fs
  fs.setDirectory('/workspace')
  fs.setDirectory('/workspace/harness')
  fs.setDirectory('/workspace/harness/context')
  fs.setFile('/workspace/AGENTS.md', '# Project rules')
  ctx.subagents = {
    getProvider: vi.fn(() => ({ name: 'codex' } as any)),
    start: vi.fn(start),
  } as any
  const service = new ContextDelegationService(ctx, { maxContextChars: 10_000 })
  const parent = { session: { header: { cwd: '/workspace' } } } as any
  const controller = new AbortController()
  return { service, parent, signal: controller.signal }
}

async function getError(promise: Promise<unknown>): Promise<ContextDelegationError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ContextDelegationError)
    return error as ContextDelegationError
  }
  throw new Error('expected delegation to fail')
}

describe('Block 3 terminal lifecycle cases', () => {
  const terminalReasons = [
    ['error', 'provider error diagnostic'],
    ['max-tokens', 'provider token-limit diagnostic'],
    ['refusal', 'provider refusal diagnostic'],
    // Future DSH versions may add reasons; the plugin must fail closed.
    ['future-stop-reason', 'future provider diagnostic'],
  ] as const

  it.each(terminalReasons)('maps stopReason=%s to a safe delegation failure', async (stopReason, diagnostic) => {
    let disposeCount = 0
    const env = makeEnvironment(async () => ({
      id: 'terminal-run' as any,
      localAgent: undefined,
      result: Promise.resolve(makeResult(stopReason as SubagentResult['stopReason'], diagnostic)),
      dispose: async () => { disposeCount += 1 },
    }))

    const error = await getError(env.service.delegate(
      { task: 'exercise terminal result' },
      { parent: env.parent, signal: env.signal },
    ))

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.details).toMatchObject({ codexInvoked: true, workspaceMayHaveChanged: true })
    expect(error.message).toContain(diagnostic)
    expect(error.message).toContain('partial text from provider')
    expect(disposeCount).toBe(1)
  })

  it('maps a result promise rejection without cancellation to delegation failure', async () => {
    let disposeCount = 0
    const rejection = new Error('infrastructure failure')
    const env = makeEnvironment(async () => ({
      id: 'rejected-run' as any,
      localAgent: undefined,
      result: Promise.reject(rejection),
      dispose: async () => { disposeCount += 1 },
    }))

    const error = await getError(env.service.delegate(
      { task: 'exercise rejected result' },
      { parent: env.parent, signal: env.signal },
    ))

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.details).toMatchObject({ codexInvoked: true, workspaceMayHaveChanged: true })
    expect(error.cause).toBe(rejection)
    expect(disposeCount).toBe(1)
  })

  it('maps a start rejection without cancellation and never disposes an unpublished run', async () => {
    const startFailure = new Error('start infrastructure failure')
    let disposeCount = 0
    const env = makeEnvironment(async () => {
      throw startFailure
    })

    const error = await getError(env.service.delegate(
      { task: 'exercise rejected start' },
      { parent: env.parent, signal: env.signal },
    ))

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.details).toMatchObject({ codexInvoked: true, workspaceMayHaveChanged: true })
    expect(error.cause).toBe(startFailure)
    expect(disposeCount).toBe(0)
  })
})
