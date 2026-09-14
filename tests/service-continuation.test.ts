import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ContextDelegationService } from '../src/index.ts'
import { parseContinuationHandoff } from '../src/continuation-handoff.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationInput } from '../src/types.ts'

function createMockCordis(providerName = 'codex', isContinuable = false) {
  const ctx = new Context()
  const fs = new RecordingFileSystem(ctx)
  ctx.fs = fs

  const workspaceRoot = '/workspace'
  fs.setDirectory(workspaceRoot)
  fs.setDirectory(`${workspaceRoot}/harness`)
  fs.setDirectory(`${workspaceRoot}/harness/context`)
  fs.setFile(`${workspaceRoot}/AGENTS.md`, '# Agents Rule\nRule 1')
  fs.setFile(`${workspaceRoot}/harness/context/CURRENT_STATE.md`, '# Current State\nActive')

  const mockProvider = {
    name: providerName,
    capabilities: {},
    ...(isContinuable ? { prepareContinuable: async () => ({}) } : {}),
  }

  const subagents: any = {
    getProvider: vi.fn().mockImplementation((name: string) => name === providerName ? mockProvider : undefined),
    start: vi.fn(),
    startContinuable: vi.fn().mockResolvedValue({ childId: 'child-1', messageId: 'msg-1' }),
    sendMessage: vi.fn().mockResolvedValue('msg-2'),
    interrupt: vi.fn().mockResolvedValue({ ok: true }),
    drainContinuableChildren: vi.fn().mockResolvedValue(undefined),
  }

  ;(ctx as any).subagents = subagents

  const emit = (event: string, payload: any) => {
    ctx.emit(event as any, payload)
  }

  return { ctx, emit, subagents, fs }
}

describe('service continuation orchestration', () => {
  const parent = {
    id: 'parent-1',
    session: {
      id: 'parent-1',
      header: { cwd: '/workspace' },
    },
  } as unknown as Agent

  it('rejects mode: continue when continuationEnabled is false', async () => {
    const { ctx } = createMockCordis('codex', false)
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: false,
    })

    const input: DelegationInput = {
      task: 'Do task',
      mode: 'continue',
      delegation_key: 'key-1',
    }

    await expect(service.delegate(input, {
      parent,
      signal: new AbortController().signal,
    })).rejects.toThrowError(/UNSUPPORTED_CONTINUATION_PROVIDER/)
  })

  it('rejects mode: continue with codex provider lacking prepareContinuable', async () => {
    const { ctx } = createMockCordis('codex', false)
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'codex', // codex lacks prepareContinuable
    })

    const input: DelegationInput = {
      task: 'Do task',
      mode: 'continue',
      delegation_key: 'key-1',
    }

    await expect(service.delegate(input, {
      parent,
      signal: new AbortController().signal,
    })).rejects.toThrowError(/UNSUPPORTED_CONTINUATION_PROVIDER/)
  })

  it('executes successful continuable multi-turn workflow on continuable provider', async () => {
    const { ctx, emit, subagents } = createMockCordis('spawn', true)
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    const inputTurn1: DelegationInput = {
      task: 'Turn 1 task',
      mode: 'continue',
      delegation_key: 'feature-auth',
    }

    const turn1Promise = service.delegate(inputTurn1, {
      parent,
      signal: new AbortController().signal,
    })

    await new Promise(r => setTimeout(r, 50))

    // Settle turn 1
    const prompt1 = subagents.startContinuable.mock.calls[0][0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    emit('subagent/end', {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Turn 1 done. [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })

    const res1 = await turn1Promise
    expect(res1.success).toBe(true)
    expect(res1.continuation?.reused).toBe(false)
    expect(res1.continuation?.contextMode).toBe('full')
    expect(res1.continuation?.delegationKey).toBe('feature-auth')
    expect(res1.codexFinal).toContain('Turn 1 done.')

    // Turn 2: continuation reuse
    const inputTurn2: DelegationInput = {
      task: 'Turn 2 follow-up task',
      mode: 'continue',
      delegation_key: 'feature-auth',
    }

    const turn2Promise = service.delegate(inputTurn2, {
      parent,
      signal: new AbortController().signal,
    })

    await new Promise(r => setTimeout(r, 50))

    expect(subagents.sendMessage).toHaveBeenCalled()

    // Settle turn 2
    const prompt2 = subagents.sendMessage.mock.calls[0][2][0].text
    const payload2 = parseContinuationHandoff(prompt2)
    emit('subagent/end', {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Turn 2 done. [DSH_CONTEXT_ACK: revision=${payload2.revision} baseRevision=${payload2.baseRevision}]` }],
    })

    const res2 = await turn2Promise
    expect(res2.success).toBe(true)
    expect(res2.continuation?.reused).toBe(true)
    expect(res2.codexFinal).toContain('Turn 2 done.')
  })

  it('preview reports planned continuation metadata without mutating session or registry', async () => {
    const { ctx } = createMockCordis('spawn', true)
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    const input: DelegationInput = {
      task: 'Preview task',
      mode: 'continue',
      delegation_key: 'preview-key',
    }

    const preview = await service.preview(input, {
      parent,
      signal: new AbortController().signal,
    })

    expect(preview.continuation).toBeDefined()
    expect(preview.continuation?.reused).toBe(false)
    expect(preview.continuation?.contextMode).toBe('full')
    expect(preview.continuation?.delegationKey).toBe('preview-key')

    // Verify no session was created in registry
    expect(service.getSessionRegistry().getSession(parent, 'preview-key', 'spawn')).toBeUndefined()
  })
})
