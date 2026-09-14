import { join } from 'node:path';
import type { ContextPatch, ContextUpdateProposal } from '../types.ts';
export interface BuildContextPatchesResult {
    readonly patches: ContextPatch[];
    readonly trustNotes: string[];
}
/**
 * Policy-check an executor proposal into auditable patches. Every dropped
 * element is recorded as a trust note; nothing is guessed into validity.
 */
export declare function buildContextPatches(proposal: ContextUpdateProposal | undefined): BuildContextPatchesResult;
/** Stable digest over the four context files' current contents. */
export declare function computeContextFingerprint(workspaceRoot: string, contextRoot: string): Promise<string>;
export interface ApplyContextPatchesResult {
    readonly applied: ContextPatch[];
    readonly fingerprintBefore: string;
    readonly fingerprintAfter: string;
}
/**
 * Apply policy-checked patches to the context files (apply mode only).
 * Each patched full text is parsed and size-checked BEFORE the write; the
 * fingerprint is recomputed after all writes confirm the change.
 */
export declare function applyContextPatches(options: {
    workspaceRoot: string;
    contextRoot: string;
    patches: readonly ContextPatch[];
    maxSnapshotBytes: number;
}): Promise<ApplyContextPatchesResult>;
export { join as contextWritebackJoin };
//# sourceMappingURL=writeback.d.ts.map