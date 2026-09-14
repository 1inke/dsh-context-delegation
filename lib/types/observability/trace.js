import { randomUUID } from 'node:crypto';
/**
 * Process-local delegation tracing (roadmap V0.7). Traces carry ONLY
 * plugin-generated metadata — never executor final text, verification
 * output, evidence file names, review reasons, error payloads, or reasoning.
 * Retention is a bounded ring buffer; nothing is persisted to disk.
 */
const TRACE_RETENTION = 20;
const MAX_TASK_PREFIX_CHARS = 200;
const ring = [];
export function startDelegationTrace(options) {
    const startedAt = Date.now();
    const trace = {
        traceId: randomUUID(),
        taskId: options.task.slice(0, MAX_TASK_PREFIX_CHARS),
        executor: options.executor,
        ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
        contextMode: 'single',
        selectedContextChars: 0,
        startedAt,
        events: [],
    };
    const mutableEvents = trace.events;
    const push = (event) => {
        mutableEvents.push(event);
    };
    const recorder = {
        traceId: trace.traceId,
        record(stage, detail) {
            push({ stage, atMs: Date.now() - startedAt, ...(detail === undefined ? {} : { detail }) });
        },
        setSelectedContextChars(chars) {
            trace.selectedContextChars = chars;
        },
        finish(outcome, fields) {
            trace.outcome = outcome;
            trace.finishedAt = Date.now();
            if (fields?.contextRevision !== undefined)
                trace.contextRevision = fields.contextRevision;
            if (fields?.contextMode !== undefined)
                trace.contextMode = fields.contextMode;
            ring.push(trace);
            while (ring.length > TRACE_RETENTION)
                ring.shift();
        },
    };
    return recorder;
}
/** The most recent traces (bounded); the newest is last. */
export function recentDelegationTraces() {
    return ring;
}
export { TRACE_RETENTION };
//# sourceMappingURL=trace.js.map