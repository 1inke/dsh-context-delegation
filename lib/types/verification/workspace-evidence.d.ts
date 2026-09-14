import type { WorkspaceEvidence } from '../types.ts';
export interface WorkspaceEvidenceOptions {
    readonly workspaceRoot: string;
    readonly signal?: AbortSignal;
}
/** Classify a git execution error into a sanitized, actionable reason. */
export declare function classifyGitError(error: unknown, fallbackReason?: string): string;
/**
 * Collect independent workspace evidence for one reviewed attempt. For a
 * non-git workspace this returns `available: false` with a reason — evidence
 * gaps are reported, never fabricated.
 */
export declare function collectWorkspaceEvidence(options: WorkspaceEvidenceOptions): Promise<WorkspaceEvidence>;
//# sourceMappingURL=workspace-evidence.d.ts.map