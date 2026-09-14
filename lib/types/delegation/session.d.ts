import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContextSnapshot } from '../types.ts';
export type DelegationSessionState = 'creating' | 'ready' | 'busy' | 'invalidating' | 'closed';
export interface DelegationSessionRecord {
    readonly parentId: string;
    readonly delegationKey: string;
    readonly provider: string;
    readonly workspaceRoot: string;
    childId: string;
    state: DelegationSessionState;
    compatibilityKey: string;
    generation: number;
    snapshot?: ContextSnapshot | undefined;
    pendingSnapshot?: ContextSnapshot | undefined;
    createdAt: number;
    lastUsedAt: number;
}
export interface SessionAcquisitionTurn {
    readonly record: DelegationSessionRecord;
    readonly isNewSession: boolean;
    setPendingSnapshot(snapshot: ContextSnapshot): void;
    commit(snapshot: ContextSnapshot): void;
    rollback(): void;
    invalidate(): Promise<void>;
}
export type SessionTurnPlan = {
    readonly mode: 'reuse';
    readonly record: DelegationSessionRecord;
    readonly baseSnapshot: ContextSnapshot;
    readonly handle: SessionAcquisitionTurn;
} | {
    readonly mode: 'create';
    completeCreation(childId: string): SessionAcquisitionTurn;
    abortCreation(): void;
};
export interface DelegationSessionRegistryOptions {
    maxSessions?: number;
    idleTtlMs?: number;
    drainChild: (parent: Agent, childId: string) => Promise<void>;
}
export declare class DelegationSessionRegistry {
    private readonly maxSessions;
    private readonly idleTtlMs;
    private readonly drainChild;
    private readonly storage;
    private readonly activeParents;
    constructor(options: DelegationSessionRegistryOptions);
    private getParentMap;
    private makeCompoundKey;
    getSession(parent: Agent, delegationKey: string, provider: string): DelegationSessionRecord | undefined;
    checkSessionCompatibility(parent: Agent, delegationKey: string, provider: string, compatibilityKey: string): {
        canReuse: boolean;
        baseSnapshot?: ContextSnapshot;
    };
    prepareSessionTurn(options: {
        parent: Agent;
        delegationKey: string;
        provider: string;
        compatibilityKey: string;
    }): Promise<SessionTurnPlan>;
    acquireOrCreateSession(options: {
        parent: Agent;
        delegationKey: string;
        provider: string;
        compatibilityKey: string;
        createChild: () => Promise<string>;
    }): Promise<SessionAcquisitionTurn>;
    private createTurnHandle;
    drainAll(): Promise<void>;
}
//# sourceMappingURL=session.d.ts.map