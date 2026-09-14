import type { DelegationInput, ContextCandidate, ContextSelection, ResolvedContextDelegationConfig } from '../types.ts';
/** Deterministic selection; rejects mandatory overflow and never borrows its reserve. */
export declare function selectContext(sources: readonly ContextCandidate[], input: DelegationInput, relevantFiles: readonly string[], rawConfig: ResolvedContextDelegationConfig): ContextSelection;
//# sourceMappingURL=selection.d.ts.map