import type { Agent } from '@deepseek-ai/dsh-agent'
import { ContextDelegationError } from '../errors.ts'
import type { ContextSnapshot } from '../types.ts'

export type DelegationSessionState =
  | 'creating'
  | 'ready'
  | 'busy'
  | 'invalidating'
  | 'closed'

export interface DelegationSessionRecord {
  readonly parentId: string
  readonly delegationKey: string
  readonly provider: string
  readonly workspaceRoot: string
  childId: string
  state: DelegationSessionState
  compatibilityKey: string
  generation: number
  snapshot?: ContextSnapshot | undefined
  pendingSnapshot?: ContextSnapshot | undefined
  createdAt: number
  lastUsedAt: number
}

export interface SessionAcquisitionTurn {
  readonly record: DelegationSessionRecord
  readonly isNewSession: boolean
  setPendingSnapshot(snapshot: ContextSnapshot): void
  commit(snapshot: ContextSnapshot): void
  rollback(): void
  invalidate(): Promise<void>
}

export type SessionTurnPlan =
  | {
      readonly mode: 'reuse'
      readonly record: DelegationSessionRecord
      readonly baseSnapshot: ContextSnapshot
      readonly handle: SessionAcquisitionTurn
    }
  | {
      readonly mode: 'create'
      completeCreation(childId: string): SessionAcquisitionTurn
      abortCreation(): void
    }

export interface DelegationSessionRegistryOptions {
  maxSessions?: number
  idleTtlMs?: number
  drainChild: (parent: Agent, childId: string) => Promise<void>
}

export class DelegationSessionRegistry {
  private readonly maxSessions: number
  private readonly idleTtlMs: number
  private readonly drainChild: (parent: Agent, childId: string) => Promise<void>

  // WeakMap isolates storage strictly by live parent Agent instance
  private readonly storage = new WeakMap<Agent, Map<string, DelegationSessionRecord>>()
  private readonly activeParents = new Set<WeakRef<Agent>>()

  constructor(options: DelegationSessionRegistryOptions) {
    this.maxSessions = options.maxSessions ?? 8
    this.idleTtlMs = options.idleTtlMs ?? 15 * 60 * 1000
    this.drainChild = options.drainChild
  }

  private getParentMap(parent: Agent): Map<string, DelegationSessionRecord> {
    let map = this.storage.get(parent)
    if (!map) {
      map = new Map()
      this.storage.set(parent, map)
      this.activeParents.add(new WeakRef(parent))
    }
    return map
  }

  private makeCompoundKey(workspaceRoot: string, provider: string, delegationKey: string): string {
    return `${workspaceRoot}::${provider}::${delegationKey}`
  }

  getSession(parent: Agent, delegationKey: string, provider: string): DelegationSessionRecord | undefined {
    const workspaceRoot = parent.session?.header?.cwd ?? ''
    const map = this.storage.get(parent)
    if (!map) return undefined
    const key = this.makeCompoundKey(workspaceRoot, provider, delegationKey)
    return map.get(key)
  }

  checkSessionCompatibility(
    parent: Agent,
    delegationKey: string,
    provider: string,
    compatibilityKey: string,
  ): { canReuse: boolean; baseSnapshot?: ContextSnapshot } {
    const workspaceRoot = parent.session?.header?.cwd ?? ''
    const map = this.storage.get(parent)
    if (!map) return { canReuse: false }
    const key = this.makeCompoundKey(workspaceRoot, provider, delegationKey)
    const record = map.get(key)
    if (!record) return { canReuse: false }
    const now = Date.now()
    if (
      record.state !== 'closed' &&
      record.state !== 'invalidating' &&
      record.state !== 'creating' &&
      now - record.lastUsedAt <= this.idleTtlMs &&
      record.compatibilityKey === compatibilityKey &&
      record.snapshot !== undefined
    ) {
      return { canReuse: true, baseSnapshot: record.snapshot }
    }
    return { canReuse: false }
  }

  async prepareSessionTurn(options: {
    parent: Agent
    delegationKey: string
    provider: string
    compatibilityKey: string
  }): Promise<SessionTurnPlan> {
    const { parent, delegationKey, provider, compatibilityKey } = options
    const workspaceRoot = parent.session?.header?.cwd
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      throw new ContextDelegationError(
        'WORKSPACE_NOT_FOUND',
        'Parent agent session has no authoritative cwd.',
        {
          layer: 'workspace',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Ensure calling agent has a valid workspace cwd.',
        },
      )
    }

    const map = this.getParentMap(parent)
    const key = this.makeCompoundKey(workspaceRoot, provider, delegationKey)
    const now = Date.now()

    let record = map.get(key)

    // 1. Check busy / creating / invalidating state on existing session
    if (record) {
      if (record.state === 'busy' || record.state === 'creating' || record.state === 'invalidating') {
        throw new ContextDelegationError(
          'DELEGATION_BUSY',
          `Delegation session "${delegationKey}" is currently executing another turn or invalidating.`,
          {
            layer: 'delegation',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Wait for the active delegation turn to complete.',
          },
        )
      }

      const isExpired = now - record.lastUsedAt > this.idleTtlMs
      const isMismatch = record.compatibilityKey !== compatibilityKey

      if (isExpired || isMismatch || record.state === 'closed') {
        // Invalidate old child
        record.state = 'invalidating'
        try {
          await this.drainChild(parent, record.childId)
        } catch (err) {
          record.state = 'closed'
          map.delete(key)
          throw err
        }
        map.delete(key)
        record = undefined
      }
    }

    // 2. Reuse valid existing session
    if (record && record.state === 'ready' && record.snapshot !== undefined) {
      record.state = 'busy'
      record.lastUsedAt = now
      record.generation += 1

      return {
        mode: 'reuse',
        record,
        baseSnapshot: record.snapshot,
        handle: this.createTurnHandle(parent, map, key, record, false),
      }
    }

    // 3. New session creation: check capacity
    if (map.size >= this.maxSessions) {
      // Find oldest idle session
      let oldestKey: string | undefined
      let oldestRecord: DelegationSessionRecord | undefined

      for (const [k, r] of map.entries()) {
        if (r.state === 'ready') {
          if (!oldestRecord || r.lastUsedAt < oldestRecord.lastUsedAt) {
            oldestKey = k
            oldestRecord = r
          }
        }
      }

      if (!oldestKey || !oldestRecord) {
        throw new ContextDelegationError(
          'SESSION_LIMIT_REACHED',
          `All ${this.maxSessions} delegation sessions for this parent are currently busy.`,
          {
            layer: 'delegation',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Wait for active delegation turns to finish before starting new sessions.',
          },
        )
      }

      // Evict oldest idle session
      oldestRecord.state = 'invalidating'
      try {
        await this.drainChild(parent, oldestRecord.childId)
      } catch {
        // ignore eviction drain error
      }
      map.delete(oldestKey)
    }

    // Synchronously place reservation in map to block concurrent attempts for this key
    const reservation: DelegationSessionRecord = {
      parentId: parent.id,
      delegationKey,
      provider,
      workspaceRoot,
      childId: '',
      state: 'creating',
      compatibilityKey,
      generation: 1,
      createdAt: now,
      lastUsedAt: now,
    }
    map.set(key, reservation)

    return {
      mode: 'create',
      completeCreation: (childId: string) => {
        reservation.childId = childId
        reservation.state = 'busy'
        return this.createTurnHandle(parent, map, key, reservation, true)
      },
      abortCreation: () => {
        map.delete(key)
        reservation.state = 'closed'
      },
    }
  }

  async acquireOrCreateSession(options: {
    parent: Agent
    delegationKey: string
    provider: string
    compatibilityKey: string
    createChild: () => Promise<string>
  }): Promise<SessionAcquisitionTurn> {
    const plan = await this.prepareSessionTurn({
      parent: options.parent,
      delegationKey: options.delegationKey,
      provider: options.provider,
      compatibilityKey: options.compatibilityKey,
    })
    if (plan.mode === 'reuse') {
      return plan.handle
    }
    try {
      const childId = await options.createChild()
      return plan.completeCreation(childId)
    } catch (error) {
      plan.abortCreation()
      throw error
    }
  }

  private createTurnHandle(
    parent: Agent,
    map: Map<string, DelegationSessionRecord>,
    key: string,
    record: DelegationSessionRecord,
    isNewSession: boolean,
  ): SessionAcquisitionTurn {
    const turnGeneration = record.generation
    let active = true

    return {
      record,
      isNewSession,
      setPendingSnapshot: (snapshot: ContextSnapshot) => {
        if (!active || record.generation !== turnGeneration) return
        record.pendingSnapshot = snapshot
      },
      commit: (snapshot: ContextSnapshot) => {
        if (!active || record.generation !== turnGeneration) return
        active = false
        record.snapshot = snapshot
        record.pendingSnapshot = undefined
        record.state = 'ready'
        record.lastUsedAt = Date.now()
      },
      rollback: () => {
        if (!active || record.generation !== turnGeneration) return
        active = false
        record.pendingSnapshot = undefined
        if (record.state === 'busy') {
          if (record.snapshot !== undefined) {
            record.state = 'ready'
          } else {
            record.state = 'closed'
            map.delete(key)
          }
        }
      },
      invalidate: async () => {
        if (!active && record.state === 'closed') return
        active = false
        record.state = 'closed'
        record.snapshot = undefined
        record.pendingSnapshot = undefined
        map.delete(key)
        if (record.childId) {
          try {
            await this.drainChild(parent, record.childId)
          } catch {
            // ignore drain error during invalidation
          }
        }
      },
    }
  }

  async drainAll(): Promise<void> {
    for (const parentRef of this.activeParents) {
      const parent = parentRef.deref()
      if (parent) {
        const map = this.storage.get(parent)
        if (map) {
          for (const record of map.values()) {
            record.state = 'invalidating'
            try {
              await this.drainChild(parent, record.childId)
            } catch {
              // ignore cleanup errors during drainAll
            }
            record.state = 'closed'
          }
          map.clear()
        }
      }
    }
    this.activeParents.clear()
  }
}
