import type { DelegationInput, ContextDelta, ContextSnapshot, ContextSnapshotUnit } from '../types.ts';
export declare const HANDOFF_PAYLOAD_V3_BEGIN = "<!--- DSH_CONTEXT_DELEGATION_V3_BEGIN --->";
export declare const HANDOFF_PAYLOAD_V3_END = "<!--- DSH_CONTEXT_DELEGATION_V3_END --->";
export interface ContinuationHandoffPayload {
    readonly protocol: 'dsh-context-delegation/v3';
    readonly contextMode: 'full' | 'delta' | 'full-refresh';
    readonly baseRevision?: string | undefined;
    readonly revision: string;
    readonly policyRevision: string;
    readonly refreshReason?: string | undefined;
    readonly context: {
        readonly units?: readonly ContextSnapshotUnit[];
        readonly added?: readonly ContextSnapshotUnit[];
        readonly changed?: readonly ContextSnapshotUnit[];
        readonly removed?: readonly {
            readonly id: string;
        }[];
    };
    readonly missingFiles: readonly string[];
    readonly sourceLimitedFiles: readonly string[];
    readonly task: string;
    readonly relevantFiles: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    readonly verificationCommands: readonly string[];
    readonly notes: string | null;
}
export declare function buildContinuationHandoff(options: {
    contextMode: 'full' | 'delta' | 'full-refresh';
    snapshot: ContextSnapshot;
    delta?: ContextDelta | undefined;
    input: DelegationInput;
    relevantFiles: readonly string[];
    refreshReason?: string | undefined;
}): {
    handoffText: string;
    payload: ContinuationHandoffPayload;
    handoffBytes: number;
};
export interface ContextAckInfo {
    valid: boolean;
    acknowledgedRevision?: string | undefined;
    acknowledgedBaseRevision?: string | undefined;
    error?: 'MISSING_ACK' | 'MULTIPLE_ACKS' | 'MALFORMED_ACK' | undefined;
}
/** Extract and validate context revision ACK marker from assistant response text. */
export declare function extractContextAck(text: string): ContextAckInfo;
export declare function parseContinuationHandoff(text: string): ContinuationHandoffPayload;
export declare function selectContinuationPayload(options: {
    baseSnapshot?: ContextSnapshot | undefined;
    currentSnapshot: ContextSnapshot;
    input: DelegationInput;
    relevantFiles: readonly string[];
    refreshReason?: string | undefined;
}): {
    payload: ContinuationHandoffPayload;
    contextMode: 'full' | 'delta' | 'full-refresh';
    handoffText: string;
    handoffBytes: number;
};
//# sourceMappingURL=protocol.d.ts.map