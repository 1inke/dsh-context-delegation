import { type BudgetedContext, type ContextBudgetPolicy, type ContextCandidate } from '../types.ts';
/**
 * Normalize line endings in text to standard POSIX newline (\n).
 * Replaces CRLF (\r\n) and legacy CR (\r) with LF (\n).
 */
export declare function normalizeContextText(text: string): string;
/**
 * Budget context candidates deterministically under maxContextChars.
 *
 * Requirements:
 * - Candidates are internally sorted by priority ascending (1 -> 6).
 * - Priority 1 (AGENTS.md) exceeding maxContextChars throws CONTEXT_TOO_LARGE.
 * - Priority 2-6 files are included fully or tail-truncated with DEFAULT_TRUNCATION_NOTICE.
 * - Truncation notice length is strictly counted in the character budget.
 * - UTF-16 surrogate pairs at cut points are protected against split.
 * - Invariant: totalChars <= policy.maxContextChars is strictly enforced.
 */
export declare function budgetContextFiles(candidates: readonly ContextCandidate[], policy: ContextBudgetPolicy): BudgetedContext;
//# sourceMappingURL=budget.d.ts.map