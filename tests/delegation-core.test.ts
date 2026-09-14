import { Context } from '@deepseek-ai/cordis'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import {
  ContextDelegationError,
  ContextDelegationService,
  HANDOFF_PAYLOAD_V2_BEGIN as HANDOFF_PAYLOAD_BEGIN,
  HANDOFF_PAYLOAD_V2_END as HANDOFF_PAYLOAD_END,
} from '../src/index.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'

interface RecordedStart {
  readonly provider: string
  readonly request: SubagentStartRequest
}

function result(
  stopReason: SubagentResult['stopReason'] = 'completed',
  options: { output?: SubagentResult['output']; diagnostic?: string } = {},
): SubagentResult {
  return {
    stopReason,
    output: options.output ?? [{ type: 'text', text: 'Codex final.' }],
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
  }
}

function run(
  execution: Promise<SubagentResult> = Promise.resolve(result()),
  dispose: () => Promise<void> = async () => undefined,
): SubagentRun {
  return {
    id: 'codex-run-1' as any,
    localAgent: undefined,
    result: execution,
    dispose,
  }
}

function createEnvironment(options: {
  providerPresent?: boolean
  start?: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun>
} = {}) {
  const ctx = new Context()
  const fs = new RecordingFileSystem(ctx)
  ctx.fs = fs
  fs.setDirectory('/workspace')
  fs.setDirectory('/workspace/harness')
  fs.setDirectory('/workspace/harness/context')
  fs.setFile('/workspace/AGENTS.md', '# Project rules')

  const starts: RecordedStart[] = []
  const providerPresent = options.providerPresent ?? true
  const start = vi.fn(async (provider: string, request: SubagentStartRequest) => {
    starts.push({ provider, request })
    return options.start === undefined ? run() : options.start(provider, request)
  })
  const getProvider = vi.fn(() => providerPresent ? ({ name: 'codex' } as any) : undefined)
  ctx.subagents = { getProvider, start } as any

  const service = new ContextDelegationService(ctx, { maxContextChars: 10_000 })
  const parent = { session: { header: { cwd: '/workspace' } } } as any
  const controller = new AbortController()
  return { service, fs, starts, start, getProvider, parent, controller }
}

async function caught(promise: Promise<unknown>): Promise<ContextDelegationError> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ContextDelegationError)
    return error as ContextDelegationError
  }
  throw new Error('Expected promise to reject')
}

describe('Block 3 foreground Codex lifecycle core', () => {
  it('sends only the exact supported request fields and returns after disposal', async () => {
    let disposed = false
    const env = createEnvironment({
      start: async () => run(
        Promise.resolve(result('completed', {
          output: [
            { type: 'reasoning', text: 'private reasoning' },
            { type: 'text', text: 'First.' },
            { type: 'text', text: ' Second.' },
          ],
          diagnostic: 'safe note',
        })),
        async () => { disposed = true },
      ),
    })

    const value = await env.service.delegate(
      { task: 'Implement feature', relevant_files: ['src/new.ts'] },
      { parent: env.parent, signal: env.controller.signal },
    )

    expect(disposed).toBe(true)
    expect(env.starts).toHaveLength(1)
    expect(env.starts[0]!.provider).toBe('codex')
    expect(Object.keys(env.starts[0]!.request).sort()).toEqual(['label', 'parent', 'prompt', 'signal'])
    expect(env.starts[0]!.request.label).toBe('Contextual Codex task')
    expect(env.starts[0]!.request.parent).toBe(env.parent)
    expect(env.starts[0]!.request.signal).toBe(env.controller.signal)
    expect(env.starts[0]!.request.prompt).toHaveLength(1)
    expect(env.starts[0]!.request.prompt[0]!.type).toBe('text')
    const prompt = (env.starts[0]!.request.prompt[0] as { type: 'text'; text: string }).text
    expect(prompt).toContain(HANDOFF_PAYLOAD_BEGIN)
    expect(prompt).toContain(HANDOFF_PAYLOAD_END)
    expect(value).toMatchObject({
      success: true,
      provider: 'codex',
      workspaceRoot: '/workspace',
      contextFilesLoaded: ['AGENTS.md'],
      runId: 'codex-run-1',
      codexFinal: 'First. Second.',
      parentVerificationRequired: true,
      diagnostic: 'safe note',
    })
  })

  it('fails before filesystem work when the configured provider is absent', async () => {
    const env = createEnvironment({ providerPresent: false })
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(error.code).toBe('CODEX_PROVIDER_NOT_FOUND')
    expect(error.details).toMatchObject({ codexInvoked: false, workspaceMayHaveChanged: false })
    expect(env.start).not.toHaveBeenCalled()
    expect(env.fs.calls).toHaveLength(0)
  })

  it('does not inspect the provider or workspace when already cancelled', async () => {
    const env = createEnvironment()
    env.controller.abort()
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(error.code).toBe('CODEX_CANCELLED')
    expect(error.details).toMatchObject({ codexInvoked: false, workspaceMayHaveChanged: false })
    expect(env.getProvider).not.toHaveBeenCalled()
    expect(env.fs.calls).toHaveLength(0)
  })

  it('maps an aborted published result to cancellation only after disposing it', async () => {
    let disposed = false
    const env = createEnvironment({
      start: async () => run(
        Promise.resolve(result('aborted', {
          diagnostic: 'cancelled by caller',
          output: [{ type: 'text', text: 'Partial edit report.' }],
        })),
        async () => { disposed = true },
      ),
    })
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(disposed).toBe(true)
    expect(error.code).toBe('CODEX_CANCELLED')
    expect(error.message).toContain('Provider diagnostic: cancelled by caller')
    expect(error.message).toContain('Partial edit report.')
    expect(error.details).toMatchObject({ codexInvoked: true, workspaceMayHaveChanged: true })
  })

  it('preserves execution and disposal failures together without reporting cancellation', async () => {
    const executionFailure = new Error('execution broke')
    const disposalFailure = new Error('cleanup broke')
    let rejectExecution!: (reason: unknown) => void
    let markStarted!: () => void
    const execution = new Promise<SubagentResult>((_resolve, reject) => { rejectExecution = reject })
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const env = createEnvironment({
      start: async () => {
        markStarted()
        return run(execution, async () => { throw disposalFailure })
      },
    })
    const delegation = env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    )
    await started
    env.controller.abort()
    rejectExecution(executionFailure)
    const error = await caught(delegation)

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.message).toContain('execution and run disposal both failed')
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors).toEqual([executionFailure, disposalFailure])
  })

  it('does not turn an aborted result with failed cleanup into clean cancellation', async () => {
    const disposalFailure = new Error('cleanup broke')
    const env = createEnvironment({
      start: async () => run(
        Promise.resolve(result('aborted')),
        async () => { throw disposalFailure },
      ),
    })
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.cause).toBeInstanceOf(AggregateError)
    const causes = (error.cause as AggregateError).errors
    expect(causes).toHaveLength(2)
    expect(causes[1]).toBe(disposalFailure)
  })

  it('treats a disposal-only failure as delegation failure rather than success', async () => {
    const disposalFailure = new Error('cleanup broke')
    const env = createEnvironment({
      start: async () => run(Promise.resolve(result()), async () => { throw disposalFailure }),
    })
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.message).toContain('could not be disposed safely')
    expect(error.cause).toBe(disposalFailure)
  })

  it('retains both failure slots even when result rejects without a reason', async () => {
    const disposalFailure = new Error('cleanup broke')
    const env = createEnvironment({
      start: async () => run(
        Promise.reject(undefined),
        async () => { throw disposalFailure },
      ),
    })
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(error.code).toBe('CODEX_DELEGATION_FAILED')
    expect(error.message).toContain('execution and run disposal both failed')
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors).toEqual([undefined, disposalFailure])
  })

  it('maps a provider-removal race during start to provider-not-found', async () => {
    const env = createEnvironment({
      start: async () => {
        throw new SubagentError('gone', 'NO_PROVIDER')
      },
    })
    const error = await caught(env.service.delegate(
      { task: 'Do work' },
      { parent: env.parent, signal: env.controller.signal },
    ))

    expect(error.code).toBe('CODEX_PROVIDER_NOT_FOUND')
    expect(error.details).toMatchObject({ codexInvoked: false, workspaceMayHaveChanged: false })
  })
})
