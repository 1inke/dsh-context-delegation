import { it, expect } from 'vitest'
import { ContinuationTransportAdapter } from '../src/continuation-transport.ts'
import { DelegationSessionRegistry } from '../src/delegation-session.ts'
import { ContextDelegationError } from '../src/errors.ts'

/**
 * Verification of fixes for defects identified in Review Round 2.
 *
 * Each test below reworks an observational defect probe into a strict acceptance test:
 * 1. Startup buffer must ignore completions belonging to unrelated children and await target child.
 * 2. Genuine DSH completion events (without messageId) must reject stale/unannounced runs and correlate the active run.
 * 3. Invalidation drain failure must not be silently swallowed; it must throw and close the session.
 * 4. Concurrent incompatible refresh calls must serialize safely: the second call must reject with DELEGATION_BUSY.
 */

it('R2: startup buffer rejects completion of a different child and awaits target child', async () => {
  const listeners: Record<string, ((info: any) => void)[]> = {}
  const emit = (event: string, payload: any) => {
    for (const cb of [...(listeners[event] ?? [])]) {
      cb(payload)
    }
  }
  const ctx: any = {
    on: (event: string, cb: any) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
      return () => {
        listeners[event] = listeners[event]?.filter(l => l !== cb) ?? []
      }
    },
    subagents: {
      getProvider: () => ({ prepareContinuable() {} }),
      startContinuable: async () => {
        // Emit unrelated child completion before startup completes
        emit('subagent/end', {
          id: 'unrelated-child',
          runId: 'other-run',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'wrong answer' }],
        })
        emit('subagent/start', { id: 'target', runId: 'target-run', provider: 'spawn', local: true })
        return { childId: 'target', messageId: 'wanted' }
      },
    },
  }
  const turnPromise = new ContinuationTransportAdapter(ctx).startChildAndTurn({
    provider: 'spawn',
    label: 'test',
    promptText: 'task',
    parent: {} as any,
    signal: new AbortController().signal,
  })

  // Await startup completion and settlement listener attachment
  await new Promise(r => setTimeout(r, 20))

  // Emit target child completion
  emit('subagent/end', {
    id: 'target',
    runId: 'target-run',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'correct answer' }],
  })

  const result = await turnPromise
  expect(result.childId).toBe('target')
  expect(result.finalText).toBe('correct answer')
})

it('R2: genuine-shaped end event without messageId rejects stale run and correlates active run', async () => {
  const listeners: Record<string, ((info: any) => void)[]> = {}
  const ctx: any = {
    on: (event: string, cb: any) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
      return () => {
        listeners[event] = listeners[event]?.filter(l => l !== cb) ?? []
      }
    },
    subagents: { sendMessage: async () => 'wanted' },
  }
  const wait = await new ContinuationTransportAdapter(ctx).sendFollowup({
    childId: 'target',
    parent: {} as any,
    promptText: 'task',
    signal: new AbortController().signal,
  })
  const pending = wait()

  // 1. Emit stale run end event (unannounced runId) -> must be rejected/ignored
  for (const cb of listeners['subagent/end'] ?? []) {
    cb({ id: 'target', runId: 'old-run', provider: 'spawn', local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'stale' }] })
  }

  // 2. Announce legitimate active run and emit its completion -> must be accepted
  for (const cb of listeners['subagent/start'] ?? []) {
    cb({ id: 'target', runId: 'active-run', provider: 'spawn', local: true })
  }
  for (const cb of listeners['subagent/end'] ?? []) {
    cb({ id: 'target', runId: 'active-run', provider: 'spawn', local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'fresh' }] })
  }

  const result = await pending
  expect(result.finalText).toBe('fresh')
})

it('R2: invalidation drain failure throws error and closes session instead of silently swallowing', async () => {
  const registry = new DelegationSessionRegistry({
    drainChild: async () => {
      throw new Error('cleanup broken')
    },
  })
  const options = {
    parent: { id: 'p', session: { header: { cwd: 'C:/fixture' } } } as any,
    delegationKey: 'k',
    provider: 'spawn',
    compatibilityKey: 'old',
    createChild: async () => 'old-child',
  }
  const first = await registry.acquireOrCreateSession(options)
  first.commit({ revision: 'r', policyRevision: 'p', units: [], missingFiles: [], sourceLimitedFiles: [] })

  await expect(
    registry.acquireOrCreateSession({ ...options, compatibilityKey: 'new', createChild: async () => 'new-child' }),
  ).rejects.toThrow('cleanup broken')
})

it('R2: concurrent incompatible refresh rejects second call with DELEGATION_BUSY', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const registry = new DelegationSessionRegistry({ drainChild: () => gate })
  const options = {
    parent: { id: 'p', session: { header: { cwd: 'C:/fixture' } } } as any,
    delegationKey: 'k',
    provider: 'spawn',
    compatibilityKey: 'old',
    createChild: async () => 'old-child',
  }
  const first = await registry.acquireOrCreateSession(options)
  first.commit({ revision: 'r', policyRevision: 'p', units: [], missingFiles: [], sourceLimitedFiles: [] })

  const a = registry.prepareSessionTurn({ ...options, compatibilityKey: 'new' })
  const b = registry.prepareSessionTurn({ ...options, compatibilityKey: 'new' })
  release()

  expect((await a).mode).toBe('create')
  await expect(b).rejects.toThrowError(ContextDelegationError)
  await expect(b).rejects.toMatchObject({ code: 'DELEGATION_BUSY' })
})

it('R2: turn failure or ACK failure invalidates session and prevents subsequent turn from reusing uncertain state', async () => {
  let drainedChildId: string | undefined
  const drainChild = async (_parent: any, childId: string) => {
    drainedChildId = childId
  }
  const registry = new DelegationSessionRegistry({ drainChild })
  const parent = { id: 'p', session: { header: { cwd: 'C:/fixture' } } } as any

  // Turn 1 succeeds and commits snapshot
  const turn1 = await registry.acquireOrCreateSession({
    parent,
    delegationKey: 'session-fail-test',
    provider: 'spawn',
    compatibilityKey: 'comp-1',
    createChild: async () => 'child-1',
  })
  turn1.commit({ revision: 'rev1', policyRevision: 'p1', units: [], missingFiles: [], sourceLimitedFiles: [] })

  // Turn 2 is acquired for continuation reuse
  const turn2 = await registry.acquireOrCreateSession({
    parent,
    delegationKey: 'session-fail-test',
    provider: 'spawn',
    compatibilityKey: 'comp-1',
    createChild: async () => 'child-1',
  })
  expect(turn2.isNewSession).toBe(false)

  // Turn 2 encounters failure (e.g. execution crash or ACK failure) -> invalidates
  await turn2.invalidate()
  expect(drainedChildId).toBe('child-1')

  // Turn 3 is requested: must NOT reuse the uncertain-state session, must create new child
  let createdNewChild = false
  const turn3 = await registry.acquireOrCreateSession({
    parent,
    delegationKey: 'session-fail-test',
    provider: 'spawn',
    compatibilityKey: 'comp-1',
    createChild: async () => {
      createdNewChild = true
      return 'child-2'
    },
  })

  expect(turn3.isNewSession).toBe(true)
  expect(turn3.record.childId).toBe('child-2')
  expect(createdNewChild).toBe(true)
})
