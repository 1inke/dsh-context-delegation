import type { DelegationTrace, DelegationTraceEvent, TraceStage } from '../types.ts';
/**
 * Process-local delegation tracing (roadmap V0.7). Traces carry ONLY
 * plugin-generated metadata — never executor final text, verification
 * output, evidence file names, review reasons, error payloads, or reasoning.
 * Retention is a bounded ring buffer; nothing is persisted to disk.
 */
declare const TRACE_RETENTION = 20;
export interface DelegationTraceRecorder {
    readonly traceId: string;
    record(stage: TraceStage, detail?: DelegationTraceEvent['detail']): void;
    setSelectedContextChars(chars: number): void;
    finish(outcome: NonNullable<DelegationTrace['outcome']>, fields?: {
        contextRevision?: string;
        contextMode?: DelegationTrace['contextMode'];
    }): void;
}
export declare function startDelegationTrace(options: {
    task: string;
    executor: string;
    reviewer?: string;
}): DelegationTraceRecorder;
/** The most recent traces (bounded); the newest is last. */
export declare function recentDelegationTraces(): readonly DelegationTrace[];
export { TRACE_RETENTION };
//# sourceMappingURL=trace.d.ts.map