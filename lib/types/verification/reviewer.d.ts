import type { ExecutorReport, ReviewReport, VerificationEvidence, WorkspaceEvidence } from '../types.ts';
/**
 * The independent reviewer: a FRESH one-shot child that receives claim and
 * evidence data (never the executor session) and returns a structured
 * verdict. It judges claim-vs-evidence consistency and criteria coverage;
 * it is not an executor and gets no tools from this plugin.
 */
export declare const REVIEW_REPORT_FENCE = "dsh-review-report";
/** Bounded context summary the reviewer receives (never full contents). */
export interface ReviewerContextSummary {
    readonly files: readonly {
        readonly relativePath: string;
    }[];
    readonly totalChars: number;
    readonly missingFiles: readonly string[];
}
export interface ReviewerPromptRequest {
    readonly task: string;
    readonly acceptanceCriteria: readonly string[];
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly context: ReviewerContextSummary;
    readonly executorReport: ExecutorReport;
    readonly workspaceEvidence: WorkspaceEvidence;
    readonly verificationEvidence: readonly VerificationEvidence[];
}
/**
 * Deterministic reviewer prompt. All executor-controlled content travels as
 * JSON data inside a marked payload; the envelope text cannot be redefined
 * from data fields.
 */
export declare function buildReviewerPrompt(request: ReviewerPromptRequest): string;
/** Parse the reviewer's final message; a broken review is `blocked`, never `pass`. */
export declare function parseReviewReport(finalText: string): ReviewReport;
//# sourceMappingURL=reviewer.d.ts.map