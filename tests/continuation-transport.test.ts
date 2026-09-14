import { describe, expect, it, vi } from 'vitest'
import {
  ContinuationTransportAdapter,
} from '../src/continuation-transport.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'

function createMockCordis(): {
  ctx: Context
  emitEnd: (info: SubagentRunEndInfo) => void
  subagents: any
} {
  const listeners = new Map<string, Function[]>()
  const on = vi.fn((event: string, handler: Function) => {
    let list = listeners.get(event)
    if (!list) {
      list = []
      listeners.set(event, list)
    }
    list.push(handler)
    return () => {
      const idx = list!.indexOf(handler)
      if (idx !== -1) list!.splice(idx, 1)
    }
  })

  const emit = (event: string, payload: any) => {
    const list = listeners.get(event) ?? []
    for (const handler of list) {
      handler(payload)
    }
  }

  const subagents = {
    startContinuable: vi.fn().mockImplementation(async () => {
      emit('subagent/start', { id: 'child-sess-1', runId: 'run-1', provider: 'spawn', local: true })
      return { childId: 'child-sess-1', messageId: 'msg-init' }
    }),
    sendMessage: vi.fn().mockImplementation(async (_parent: any, childId: string) => {
      emit('subagent/start', { id: childId, runId: 'run-2', provider: 'spawn', local: true })
      return 'msg-followup'
    }),
    interrupt: vi.fn().mockResolvedValue({ ok: true }),
    drainContinuableChildren: vi.fn().mockResolvedValue(undefined),
    getProvider: vi.fn(),
  }

  const ctx = {
    subagents,
    on,
  } as unknown as Context

  return {
    ctx,
    emitEnd: (info: SubagentRunEndInfo) => emit('subagent/end', info),
    subagents,
  }
}

describe('continuation transport adapter', () => {
  it('establishes new continuable child and awaits correlated turn settlement', async () => {
    const { ctx, emitEnd, subagents } = createMockCordis()
    subagents.getProvider.mockReturnValue({ prepareContinuable: async () => ({}) })

    const transport = new ContinuationTransportAdapter(ctx)
    const parent = { id: 'parent-agent' } as Agent
    const controller = new AbortController()

    const turnPromise = transport.startChildAndTurn({
      provider: 'spawn',
      label: 'test task',
      promptText: 'handoff text',
      parent,
      signal: controller.signal,
    })

    // Simulate child startup resolving and listener attachment
    await new Promise(r => setTimeout(r, 20))

    // Simulate turn completion event from subagent/end
    emitEnd({
      runId: 'run-1' as any,
      provider: 'spawn',
      id: 'child-sess-1' as any,
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'Task completed successfully.' }],
    })

    const result = await turnPromise
    expect(result.childId).toBe('child-sess-1')
    expect(result.stopReason).toBe('completed')
    expect(result.finalText).toBe('Task completed successfully.')
  })

  it('delivers follow-up turn via sendMessage and correlates child settlement', async () => {
    const { ctx, emitEnd } = createMockCordis()

    const transport = new ContinuationTransportAdapter(ctx)
    const parent = { id: 'parent-agent' } as Agent
    const controller = new AbortController()

    const turnPromise = transport.sendFollowupTurn({
      parent,
      childId: 'child-sess-1',
      promptText: 'delta follow-up text',
      signal: controller.signal,
    })

    await new Promise(r => setTimeout(r, 20))

    emitEnd({
      runId: 'run-2' as any,
      provider: 'spawn',
      id: 'child-sess-1' as any,
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'Follow-up finished.' }],
    })

    const result = await turnPromise
    expect(result.childId).toBe('child-sess-1')
    expect(result.stopReason).toBe('completed')
    expect(result.finalText).toBe('Follow-up finished.')
  })

  it('rejects with CODEX_CANCELLED when aborted before inbox acceptance', async () => {
    const { ctx } = createMockCordis()
    const transport = new ContinuationTransportAdapter(ctx)
    const parent = { id: 'parent-agent' } as Agent
    const controller = new AbortController()
    controller.abort() // Pre-aborted

    await expect(transport.startChildAndTurn({
      provider: 'spawn',
      label: 'task',
      promptText: 'handoff text',
      parent,
      signal: controller.signal,
    })).rejects.toThrowError(/CODEX_CANCELLED/)
  })

  it('triggers fire-and-return interrupt and awaits quiescence when aborted during execution', async () => {
    const { ctx, emitEnd, subagents } = createMockCordis()
    subagents.getProvider.mockReturnValue({ prepareContinuable: async () => ({}) })

    const transport = new ContinuationTransportAdapter(ctx)
    const parent = { id: 'parent-agent' } as Agent
    const controller = new AbortController()

    const turnPromise = transport.startChildAndTurn({
      provider: 'spawn',
      label: 'test task',
      promptText: 'handoff text',
      parent,
      signal: controller.signal,
    })

    // Wait for inbox acceptance
    await Promise.resolve()
    await Promise.resolve()

    // Abort while running
    controller.abort()

    expect(subagents.interrupt).toHaveBeenCalledWith('child-sess-1', {
      kind: 'ancestor',
      agent: parent,
    })

    // Settle after interrupt
    emitEnd({
      runId: 'run-1' as any,
      provider: 'spawn',
      id: 'child-sess-1' as any,
      local: true,
      stopReason: 'aborted',
      lastAssistantMessage: [],
    })

    await expect(turnPromise).rejects.toThrowError(/CODEX_CANCELLED/)
  })

  it('rejects with UNSUPPORTED_CONTINUATION_PROVIDER if provider lacks prepareContinuable', async () => {
    const { ctx, subagents } = createMockCordis()
    subagents.getProvider.mockReturnValue({
      name: 'codex',
      capabilities: {},
      // prepareContinuable is absent
    })

    const transport = new ContinuationTransportAdapter(ctx)
    const parent = { id: 'parent-agent' } as Agent
    const controller = new AbortController()

    await expect(transport.startChildAndTurn({
      provider: 'codex',
      label: 'task',
      promptText: 'text',
      parent,
      signal: controller.signal,
    })).rejects.toThrowError(/UNSUPPORTED_CONTINUATION_PROVIDER/)
  })
})
