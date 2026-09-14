import type { DelegationTraceRecorder } from '../trace.ts';
import type { DelegationInput, DelegationResult, DelegationExecution, ResolvedContextDelegationConfig } from '../types.ts';
/**
 * The bounded reviewed delegation loop:
 *   executor (fresh) -> independent evidence -> verification -> reviewer
 *   -> pass ends / rework retries within maxReviewRounds / blocked stops.
 *
 * The reviewer is always a FRESH one-shot child on its own provider name and
 * never sees the executor's session. BLOCKED outcomes are propagated as
 * `outcome: 'blocked'` and are never wrapped into plain success by callers.
 */
/** True when the caller explicitly asked for the reviewed flow. */
export declare function hasReviewRequest(input: DelegationInput): boolean;
export interface ReviewLoopDeps {
    readonly config: ResolvedContextDelegationConfig;
    /** Observability recorder (V0.7); metadata only, never payloads. */
    readonly trace?: DelegationTraceRecorder;
    /** Run one fresh executor attempt (the unreviewed fresh delegation path). */
    runFreshAttempt(input: DelegationInput, execution: DelegationExecution): Promise<DelegationResult>;
    /** Run one FRESH reviewer child; never reuses the executor child/session. */
    startReviewer(promptText: string, execution: DelegationExecution): Promise<{
        runId: string;
        finalText: string;
    }>;
}
/** The loop only forwards the caller's execution object; it never rebuilds one. */
export type DepsExecution = DelegationExecution;
export declare function runReviewedDelegation(deps: ReviewLoopDeps, input: DelegationInput, execution: DelegationExecution): Promise<DelegationResult>;
/** Finish the trace with metadata only: a revision fingerprint, never payloads. */
export declare function finishLoopTrace(deps: {
    config: ResolvedContextDelegationConfig;
}, trace: DelegationTraceRecorder | undefined, result: DelegationResult | undefined, outcome: 'completed' | 'rework' | 'blocked' | 'failed', revision?: string): Promise<void>;
//# sourceMappingURL=review-loop.d.ts.map