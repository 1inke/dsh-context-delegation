import { describe, expect, it } from 'vitest'
import { DelegationSessionRegistry } from '../src/delegation-session.ts'
import { ContinuationTransportAdapter } from '../src/continuation-transport.ts'
import {
  buildContinuationHandoff,
  parseContinuationHandoff,
  HANDOFF_PAYLOAD_V3_END,
} from '../src/continuation-handoff.ts'
import { ContextDelegationError } from '../src/errors.ts'

describe('Rework verification: Asserting correct behavior for the 5 review probes', () => {
  it('1. Simultaneous first calls reject the concurrent call with DELEGATION_BUSY and create only one child', async () => {
    const registry = new DelegationSessionRegistry({ drainChild: async () => {} })
    let created = 0
    const options = {
      parent: { id: 'p', session: { header: { cwd: 'C:/fixture' } } } as any,
      delegationKey: 'same',
      provider: 'spawn',
      compatibilityKey: 'v1',
      createChild: async () => {
        await new Promise(r => setTimeout(r, 20))
        return `child-${++created}`
      },
    }

    const results = await Promise.allSettled([
      registry.acquireOrCreateSession(options),
      registry.acquireOrCreateSession(options),
    ])

    expect(created).toBe(1)
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(rejected[0]!.reason).toBeInstanceOf(ContextDelegationError)
    expect(rejected[0]!.reason.code).toBe('DELEGATION_BUSY')
  })

  it('2. Failed drainChild must reject with error rather than swallowing failure', async () => {
    const ctx: any = {
      on: () => () => {},
      subagents: {
        getProvider: () => ({ prepareContinuable() {} }),
        drainContinuableChildren: async () => {
          throw new Error('underlying drain failed')
        },
      },
    }
    const adapter = new ContinuationTransportAdapter(ctx)
    await expect(adapter.drainChild({} as any, 'child')).rejects.toThrow('underlying drain failed')
  })

  it('3. Early completion is captured before awaitSettlement, and cancellation with missing end event settles within bounded timeout', async () => {
    let listener: ((event: any) => void) | undefined
    const emit = (msg = 'early result') =>
      listener?.({
        id: 'child',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: msg }],
      })

    const ctx: any = {
      on: (_: string, cb: any) => {
        listener = cb
        return () => {
          listener = undefined
        }
      },
      subagents: {
        getProvider: () => ({ prepareContinuable() {} }),
        startContinuable: async () => {
          // Emit synchronously during creation before awaitSettlement is invoked
          emit('early result')
          return { childId: 'child', messageId: 'new-message' }
        },
        interrupt: () => {},
        drainContinuableChildren: async () => {},
      },
    }

    const adapter = new ContinuationTransportAdapter(ctx, { quiescenceTimeoutMs: 50 })
    const controller = new AbortController()
    const start = await adapter.startChild({
      provider: 'spawn',
      label: 'test',
      promptText: 'task',
      parent: {} as any,
      signal: controller.signal,
    })

    // Because early completion was captured, awaitSettlement resolves with that completion
    const earlyRes = await start.awaitSettlement()
    expect(earlyRes.finalText).toBe('early result')

    // Now test cancellation when child hangs (no end event ever arrives)
    const hangingAdapter = new ContinuationTransportAdapter(
      {
        on: () => () => {},
        subagents: {
          getProvider: () => ({ prepareContinuable() {} }),
          startContinuable: async () => ({ childId: 'hanging-child', messageId: 'm1' }),
          interrupt: () => {},
          drainContinuableChildren: async () => {},
        },
      } as any,
      { quiescenceTimeoutMs: 50 },
    )

    const hangController = new AbortController()
    const hangStart = await hangingAdapter.startChild({
      provider: 'spawn',
      label: 'test-hang',
      promptText: 'task',
      parent: {} as any,
      signal: hangController.signal,
    })

    const settlePromise = hangStart.awaitSettlement()
    hangController.abort()

    // Must settle with CODEX_CANCELLED within quiescence timeout without hanging forever
    await expect(settlePromise).rejects.toThrowError(/CODEX_CANCELLED/)
  })

  it('4. Old completion event for same child is not accepted for a new turn', async () => {
    let listener: ((event: any) => void) | undefined
    let currentMessageId = 0

    const ctx: any = {
      on: (_: string, cb: any) => {
        listener = cb
        return () => {
          listener = undefined
        }
      },
      subagents: {
        getProvider: () => ({ prepareContinuable() {} }),
        sendMessage: async () => `msg-${++currentMessageId}`,
        interrupt: () => {},
      },
    }

    const adapter = new ContinuationTransportAdapter(ctx)
    const wait = await adapter.sendFollowup({
      parent: {} as any,
      childId: 'child',
      promptText: 'new task',
      signal: new AbortController().signal,
    })

    const pending = wait()

    // Emit an old / previous turn completion (e.g. without runId/messageId matching current turn)
    listener?.({
      id: 'child',
      runId: 'old-run-id',
      messageId: 'msg-0', // old message
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'old result' }],
    })

    // The pending turn must NOT resolve with old result!
    const raceOutcome = await Promise.race([
      pending.then(res => res.finalText),
      new Promise(resolve => setTimeout(() => resolve('still_waiting'), 40)),
    ])
    expect(raceOutcome).toBe('still_waiting')

    // Now emit the correct completion matching current message
    listener?.({
      id: 'child',
      messageId: `msg-${currentMessageId}`,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'correct new result' }],
    })

    const result = await pending
    expect(result.finalText).toBe('correct new result')
  })

  it('5. Delimiter in task does not break generated handoff payload parser', () => {
    const taskWithDelimiter = `This task discusses delimiter: ${HANDOFF_PAYLOAD_V3_END} and ends properly.`
    const result = buildContinuationHandoff({
      contextMode: 'full',
      snapshot: {
        revision: 'r1',
        policyRevision: 'p1',
        units: [],
        missingFiles: [],
        sourceLimitedFiles: [],
      },
      input: { task: taskWithDelimiter } as any,
      relevantFiles: [],
    })

    const parsed = parseContinuationHandoff(result.handoffText)
    expect(parsed.task).toBe(taskWithDelimiter)
  })
})
