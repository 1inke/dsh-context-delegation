import type { ExecutorReport } from '../types.ts';
/**
 * Fence label the handoff instructs the executor to use for its structured
 * self-report. The report is a CLAIM surface for the reviewer, never
 * acceptance evidence.
 */
export declare const EXECUTOR_REPORT_FENCE = "dsh-executor-report";
/**
 * Extract the LAST `dsh-executor-report` fence from the executor's final
 * message and coerce it conservatively. A missing, malformed, or lying
 * report degrades to `status: 'failed'` with a trust note — it can never be
 * upgraded into success. The full text remains available to the caller
 * separately, so nothing is lost by coercion.
 */
export declare function parseExecutorReport(finalText: string): ExecutorReport;
//# sourceMappingURL=executor-report.d.ts.map