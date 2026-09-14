import type { ContextBundle, ContextCandidate, ContextFileId, LoadPersistentContextRequest, ResolvedContextDelegationConfig } from '../types.ts';
export { DEFAULT_TRUNCATION_NOTICE } from '../types.ts';
export interface ContextFilePlanEntry {
    readonly id: ContextFileId;
    readonly relativePath: string;
    readonly priority: number;
}
/** Produce the fixed, deterministic V0.1 read plan. No repository scan is performed. */
export declare function createContextFilePlan(config: ResolvedContextDelegationConfig): readonly ContextFilePlanEntry[];
export type ContextLoader = (request: LoadPersistentContextRequest) => Promise<ContextBundle>;
/**
 * Load persistent context files within the workspace according to the resolved plan and budget.
 */
export declare function loadContextCandidates(request: LoadPersistentContextRequest): Promise<{
    candidates: ContextCandidate[];
    missingFiles: string[];
}>;
/** V0.1-compatible public loader, sharing exactly the same secure read path. */
export declare function loadPersistentContext(request: LoadPersistentContextRequest): Promise<ContextBundle>;
//# sourceMappingURL=loader.d.ts.map