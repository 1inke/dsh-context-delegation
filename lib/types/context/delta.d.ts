import type { ContextDelta, ContextSnapshot } from '../types.ts';
/**
 * Compute the deterministic delta between base and target ContextSnapshots.
 */
export declare function diffContextSnapshots(base: ContextSnapshot, target: ContextSnapshot): ContextDelta;
/**
 * Pure function to validate and apply a ContextDelta to a base ContextSnapshot.
 * Invariant: applyContextDelta(A, diffContextSnapshots(A, B)) === B
 */
export declare function applyContextDelta(base: ContextSnapshot, delta: ContextDelta): ContextSnapshot;
//# sourceMappingURL=delta.d.ts.map