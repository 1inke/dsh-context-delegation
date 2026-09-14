import { describe, expect, it, vi } from 'vitest'
import {
  DelegationSessionRegistry,
} from '../src/delegation-session.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextSnapshot } from '../src/types.ts'

function createMockAgent(id: string, cwd: string = 'C:/test/workspace'): Agent {
  return {
    id,
    session: {
      id,
      header: { cwd },
    },
  } as unknown as Agent
}

function createMockSnapshot(rev: string): ContextSnapshot {
  return {
    revision: `sha256:${rev}`,
    policyRevision: 'sha256:policy1',
    units: [],
    missingFiles: [],
    sourceLimitedFiles: [],
  }
}

describe('delegation session registry', () => {
  it('isolates sessions between different parent agents even with identical workspace and key', async () => {
    const drainChild = vi.fn().mockResolvedValue(undefined)
    const registry = new DelegationSessionRegistry({
      maxSessions: 8,
      idleTtlMs: 60_000,
      drainChild,
    })

    const parent1 = createMockAgent('agent-1')
    const parent2 = createMockAgent('agent-2')

    const turn1 = await registry.acquireOrCreateSession({
      parent: parent1,
      delegationKey: 'key-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })

    expect(turn1.record.childId).toBe('child-1')
    turn1.commit(createMockSnapshot('rev1'))

    const turn2 = await registry.acquireOrCreateSession({
      parent: parent2,
      delegationKey: 'key-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-2',
    })

    expect(turn2.record.childId).toBe('child-2')
    turn2.commit(createMockSnapshot('rev1'))

    expect(turn1.record.childId).not.toBe(turn2.record.childId)
  })

  it('rejects concurrent acquisition on the same session with DELEGATION_BUSY', async () => {
    const registry = new DelegationSessionRegistry({
      maxSessions: 8,
      idleTtlMs: 60_000,
      drainChild: vi.fn().mockResolvedValue(undefined),
    })

    const parent = createMockAgent('agent-1')

    const turn1 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })

    // While turn1 is in progress (busy), turn2 must throw DELEGATION_BUSY
    await expect(registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })).rejects.toThrowError(/DELEGATION_BUSY/)

    turn1.commit(createMockSnapshot('rev1'))

    // After commit, state is ready so subsequent acquisition succeeds
    const turn3 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-should-not-be-called',
    })
    expect(turn3.record.childId).toBe('child-1')
    expect(turn3.record.snapshot?.revision).toBe('sha256:rev1')
    turn3.rollback()
  })

  it('enforces transactional commit: rollbacks do not commit snapshot', async () => {
    const registry = new DelegationSessionRegistry({
      maxSessions: 8,
      idleTtlMs: 60_000,
      drainChild: vi.fn().mockResolvedValue(undefined),
    })

    const parent = createMockAgent('agent-1')

    const turn1 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })

    turn1.commit(createMockSnapshot('rev1'))

    const turn2 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })

    turn2.setPendingSnapshot(createMockSnapshot('rev2'))
    // Turn 2 fails / aborts
    turn2.rollback()

    const record = registry.getSession(parent, 'worker-1', 'spawn')
    expect(record?.snapshot?.revision).toBe('sha256:rev1')
    expect(record?.pendingSnapshot).toBeUndefined()
  })

  it('invalidates and recreates child when compatibilityKey changes', async () => {
    const drainChild = vi.fn().mockResolvedValue(undefined)
    const registry = new DelegationSessionRegistry({
      maxSessions: 8,
      idleTtlMs: 60_000,
      drainChild,
    })

    const parent = createMockAgent('agent-1')

    const turn1 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'rule-version-1',
      createChild: async () => 'child-1',
    })
    turn1.commit(createMockSnapshot('rev1'))

    // New turn with different rule version / compatibility key
    const turn2 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'worker-1',
      provider: 'spawn',
      compatibilityKey: 'rule-version-2',
      createChild: async () => 'child-2',
    })

    expect(drainChild).toHaveBeenCalledWith(parent, 'child-1')
    expect(turn2.record.childId).toBe('child-2')
    expect(turn2.record.snapshot).toBeUndefined()
    turn2.commit(createMockSnapshot('rev1-new'))
  })

  it('evicts oldest idle session when maxSessions capacity is reached', async () => {
    const drainChild = vi.fn().mockResolvedValue(undefined)
    const registry = new DelegationSessionRegistry({
      maxSessions: 2,
      idleTtlMs: 60_000,
      drainChild,
    })

    const parent = createMockAgent('agent-1')

    const turn1 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'session-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })
    turn1.commit(createMockSnapshot('rev1'))

    const turn2 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'session-2',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-2',
    })
    turn2.commit(createMockSnapshot('rev2'))

    // Now 2 sessions are present. Creating a 3rd should evict session-1
    const turn3 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'session-3',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-3',
    })
    turn3.commit(createMockSnapshot('rev3'))

    expect(drainChild).toHaveBeenCalledWith(parent, 'child-1')
    expect(registry.getSession(parent, 'session-1', 'spawn')).toBeUndefined()
    expect(registry.getSession(parent, 'session-2', 'spawn')).toBeDefined()
    expect(registry.getSession(parent, 'session-3', 'spawn')).toBeDefined()
  })

  it('rejects creation if all sessions are busy and capacity is reached', async () => {
    const registry = new DelegationSessionRegistry({
      maxSessions: 1,
      idleTtlMs: 60_000,
      drainChild: vi.fn().mockResolvedValue(undefined),
    })

    const parent = createMockAgent('agent-1')

    const turn1 = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'session-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })
    // turn1 is still busy

    await expect(registry.acquireOrCreateSession({
      parent,
      delegationKey: 'session-2',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-2',
    })).rejects.toThrowError(/SESSION_LIMIT_REACHED/)

    turn1.rollback()
  })

  it('cleans up all sessions when drainAll is called', async () => {
    const drainChild = vi.fn().mockResolvedValue(undefined)
    const registry = new DelegationSessionRegistry({
      maxSessions: 8,
      idleTtlMs: 60_000,
      drainChild,
    })

    const parent = createMockAgent('agent-1')
    const turn = await registry.acquireOrCreateSession({
      parent,
      delegationKey: 'session-1',
      provider: 'spawn',
      compatibilityKey: 'comp-1',
      createChild: async () => 'child-1',
    })
    turn.commit(createMockSnapshot('rev1'))

    await registry.drainAll()

    expect(drainChild).toHaveBeenCalledWith(parent, 'child-1')
    expect(registry.getSession(parent, 'session-1', 'spawn')).toBeUndefined()
  })
})
