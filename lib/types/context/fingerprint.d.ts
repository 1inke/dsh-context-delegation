import type { ContextBudgets, ContextBundle, ContextFileId, ContextSnapshot, ContextSnapshotUnit, LoadedContextFile } from '../types.ts';
/** Compute SHA-256 hex digest of a UTF-8 string. */
export declare function computeSha256(data: string): string;
/** Compute stable structural identity of a context unit independent of content and line numbers. */
export declare function computeUnitId(sourceId: ContextFileId, relativePath: string, headingPath: readonly string[], partIndex: number): string;
/** Compute content hash from normalized text. */
export declare function computeContentHash(content: string): string;
/** Create a normalized context snapshot unit. */
export declare function createSnapshotUnit(options: {
    sourceId: ContextFileId;
    relativePath: string;
    headingPath: readonly string[];
    partIndex: number;
    content: string;
}): ContextSnapshotUnit;
export interface PolicyRevisionOptions {
    mandatoryFiles: readonly (LoadedContextFile | {
        id: ContextFileId;
        content: string;
    })[];
    missingFiles: readonly string[];
    contextRoot: string;
    maxContextChars: number;
    protocolVersion?: string;
    includeFlags?: {
        includeAgents?: boolean;
        includeProjectContext?: boolean;
        includeCurrentState?: boolean;
        includeDecisions?: boolean;
        includeExperiments?: boolean;
        includeHandoffRules?: boolean;
    };
    budgets?: ContextBudgets;
    contextMinRelativeScore?: number;
}
/** Compute deterministic policy revision covering safety rules, protocol boundaries, and budgets. */
export declare function computePolicyRevision(options: PolicyRevisionOptions): string;
/** Build a canonical ContextSnapshot from a ContextBundle and policyRevision. */
export declare function buildContextSnapshot(options: {
    bundle: ContextBundle;
    policyRevision: string;
    maxSnapshotBytes?: number;
}): ContextSnapshot;
//# sourceMappingURL=fingerprint.d.ts.map