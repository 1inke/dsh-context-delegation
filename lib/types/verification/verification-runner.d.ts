import type { VerificationEvidence } from '../types.ts';
/**
 * Execute ONLY the caller-authorized verification command strings, in the
 * workspace, with bounded time/output and cancellation. Executor-claimed
 * commands never reach this runner. Denied commands are recorded as
 * `not-run` with a reason — never silently dropped, never executed.
 *
 * Timeouts and cancellation kill the WHOLE process tree: on Windows the
 * platform shell spawns a grandchild, and killing only the shell would leave
 * it running inside the workspace after the runner returned.
 */
/** Case-insensitive substring deny patterns for obviously unsafe commands. */
export declare const VERIFICATION_DENY_PATTERNS: readonly RegExp[];
export interface VerificationRunOptions {
    readonly workspaceRoot: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxOutputChars?: number;
}
export declare function isDeniedCommand(command: string): boolean;
/**
 * Run the authorized commands sequentially and return independent evidence.
 * Denied commands yield `outcome: 'not-run'` with a denial reason; commands
 * that cannot start (missing interpreter) also yield `not-run`.
 */
export declare function runVerificationCommands(commands: readonly string[], options: VerificationRunOptions): Promise<VerificationEvidence[]>;
//# sourceMappingURL=verification-runner.d.ts.map