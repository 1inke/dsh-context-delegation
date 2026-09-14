import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ContextDelegationService,
  HANDOFF_PAYLOAD_V3_BEGIN,
} from '../src/index.ts'
import { parseContinuationHandoff } from '../src/continuation-handoff.ts'
import { apply as applyPreview } from '../src/preview.ts'
import { apply as applyExpert } from '../src/tool.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationResult } from '../src/types.ts'

describe('continuation mock integration: real LocalFS with simulated subagent transport', () => {
  function createE2eEnvironment() {
    const root = resolve(import.meta.dirname, 'fixtures/retrieval-project')
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })

    const mockSpawnProvider = {
      name: 'spawn',
      capabilities: {},
      prepareContinuable: async () => ({}),
    }

    const mockCodexProvider = {
      name: 'codex',
      capabilities: {},
      // No prepareContinuable
    }

    const subagents: any = {
      getProvider: vi.fn((name: string) => {
        if (name === 'spawn') return mockSpawnProvider
        if (name === 'codex') return mockCodexProvider
        return undefined
      }),
      start: vi.fn(async () => ({
        id: 'fresh-run',
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'Fresh completed.' }],
        }),
        dispose: vi.fn(),
      })),
      startContinuable: vi.fn().mockResolvedValue({
        childId: 'child-sess-e2e-1',
        messageId: 'msg-1',
      }),
      sendMessage: vi.fn().mockResolvedValue('msg-2'),
      interrupt: vi.fn().mockResolvedValue({ ok: true }),
      drainContinuableChildren: vi.fn().mockResolvedValue(undefined),
    }
    ctx.subagents = subagents

    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    const tools: ToolDefinition[] = []
    ctx.tools = { register: (tool: ToolDefinition) => { tools.push(tool) } } as any
    applyExpert(ctx)
    applyPreview(ctx)

    const emit = (event: string, payload: any) => {
      ctx.emit(event as any, payload)
    }

    return {
      root,
      ctx,
      service,
      tools,
      subagents,
      emit,
    }
  }

  function makeAgent(id: string, root: string): Agent {
    return {
      id,
      session: {
        id,
        header: { cwd: root },
      },
    } as unknown as Agent
  }

  function makeExec(agent: Agent, signal: AbortSignal = new AbortController().signal) {
    return {
      agent,
      signal,
    } as any
  }

  it('runs multi-turn continuation with full first turn and delta second turn', async () => {
    const { root, tools, emit, subagents } = createE2eEnvironment()
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const previewTool = tools.find(t => t.name === 'context_preview')!
    const parent = makeAgent('parent-agent-1', root)

    // 1. Preview initial continuation turn
    const previewRaw = await previewTool.execute({
      task: 'Investigate AV2 sampling',
      relevant_files: ['src/av2/sampling.ts'],
      mode: 'continue',
      delegation_key: 'session-e2e',
    }, makeExec(parent))
    const preview = JSON.parse(previewRaw as string)

    expect(preview.continuation).toBeDefined()
    expect(preview.continuation.reused).toBe(false)
    expect(preview.continuation.contextMode).toBe('full')

    // 2. Execute Turn 1
    const turn1Promise = expertTool.execute({
      task: 'Investigate AV2 sampling',
      relevant_files: ['src/av2/sampling.ts'],
      mode: 'continue',
      delegation_key: 'session-e2e',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))

    // Settle Turn 1
    const prompt1 = subagents.startContinuable.mock.calls[0][0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    emit('subagent/end', {
      id: 'child-sess-e2e-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Investigation complete: sampling requires adjustment. [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })

    const res1 = (await turn1Promise) as DelegationResult
    expect(res1.success).toBe(true)
    expect(res1.continuation?.reused).toBe(false)
    expect(res1.continuation?.contextMode).toBe('full')
    expect(res1.codexFinal).toContain('Investigation complete')

    // Verify V3 full handoff was passed to child
    expect(subagents.startContinuable).toHaveBeenCalledTimes(1)
    expect(prompt1).toContain(HANDOFF_PAYLOAD_V3_BEGIN)
    expect(payload1.contextMode).toBe('full')
    expect(payload1.task).toBe('Investigate AV2 sampling')

    // 3. Execute Turn 2 (Continuation reuse with delta)
    const turn2Promise = expertTool.execute({
      task: 'Apply the sampling adjustment',
      relevant_files: ['src/av2/sampling.ts'],
      mode: 'continue',
      delegation_key: 'session-e2e',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.sendMessage).toHaveBeenCalledTimes(1))

    const prompt2 = subagents.sendMessage.mock.calls[0][2][0].text
    expect(prompt2).toContain(HANDOFF_PAYLOAD_V3_BEGIN)
    const payload2 = parseContinuationHandoff(prompt2)
    expect(payload2.baseRevision).toBe(payload1.revision)

    // Settle Turn 2
    emit('subagent/end', {
      id: 'child-sess-e2e-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Sampling adjustments applied and tests pass. [DSH_CONTEXT_ACK: revision=${payload2.revision} baseRevision=${payload2.baseRevision}]` }],
    })

    const res2 = (await turn2Promise) as DelegationResult
    expect(res2.success).toBe(true)
    expect(res2.continuation?.reused).toBe(true)
    expect(res2.codexFinal).toContain('Sampling adjustments applied')
  })

  it('preserves isolation between different parent agents using same delegation key', async () => {
    const { root, tools, emit, subagents } = createE2eEnvironment()
    const expertTool = tools.find(t => t.name === 'codex_expert')!

    const parentA = makeAgent('parent-A', root)
    const parentB = makeAgent('parent-B', root)

    // Turn 1 on Parent A
    const turnAPromise = expertTool.execute({
      task: 'Task on parent A',
      mode: 'continue',
      delegation_key: 'shared-key',
    }, makeExec(parentA))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))
    const promptA = subagents.startContinuable.mock.calls[0][0].request.prompt[0].text
    const payloadA = parseContinuationHandoff(promptA)
    emit('subagent/end', {
      id: 'child-sess-e2e-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Done A [DSH_CONTEXT_ACK: revision=${payloadA.revision}]` }],
    })
    const resA = (await turnAPromise) as DelegationResult
    expect(resA.continuation?.reused).toBe(false)

    // Turn 1 on Parent B with same delegation key -> MUST NOT reuse Parent A's session!
    subagents.startContinuable.mockResolvedValueOnce({
      childId: 'child-sess-e2e-2',
      messageId: 'msg-parent-b',
    })

    const turnBPromise = expertTool.execute({
      task: 'Task on parent B',
      mode: 'continue',
      delegation_key: 'shared-key',
    }, makeExec(parentB))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(2))
    const promptB = subagents.startContinuable.mock.calls[1][0].request.prompt[0].text
    const payloadB = parseContinuationHandoff(promptB)
    emit('subagent/end', {
      id: 'child-sess-e2e-2',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Done B [DSH_CONTEXT_ACK: revision=${payloadB.revision}]` }],
    })
    const resB = (await turnBPromise) as DelegationResult
    expect(resB.continuation?.reused).toBe(false)
    expect(resB.runId).toBe('child-sess-e2e-2')
  })

  it('handles abort and cancellation cleanly during execution', async () => {
    const { root, tools, emit, subagents } = createE2eEnvironment()
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const parent = makeAgent('parent-agent-cancel', root)
    const controller = new AbortController()

    const turnPromise = expertTool.execute({
      task: 'Task to cancel',
      mode: 'continue',
      delegation_key: 'cancel-key',
    }, makeExec(parent, controller.signal))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))

    // Abort mid-flight
    controller.abort()

    expect(subagents.interrupt).toHaveBeenCalledWith('child-sess-e2e-1', {
      kind: 'ancestor',
      agent: parent,
    })

    // Settle as aborted
    emit('subagent/end', {
      id: 'child-sess-e2e-1',
      provider: 'spawn',
      stopReason: 'aborted',
      lastAssistantMessage: [],
    })

    await expect(turnPromise).rejects.toThrowError(/CODEX_CANCELLED/)
  })

  it('keeps default mode: fresh completely unaffected', async () => {
    const { root, tools, subagents } = createE2eEnvironment()
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const parent = makeAgent('parent-agent-fresh', root)

    const res = (await expertTool.execute({
      task: 'Fresh task',
      relevant_files: ['src/av2/sampling.ts'],
    }, makeExec(parent))) as DelegationResult

    expect(res.success).toBe(true)
    expect(res.continuation).toBeUndefined()
    expect(res.codexFinal).toBe('Fresh completed.')
    expect(subagents.start).toHaveBeenCalledTimes(1)
  })
})
