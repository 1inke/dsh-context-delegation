import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent';
export declare const MAX_FAILURE_PARTIAL_CHARS = 8000;
export declare const MAX_PROVIDER_DIAGNOSTIC_BYTES = 4096;
export interface CodexRunSettlement {
    readonly execution: PromiseSettledResult<SubagentResult>;
    readonly disposal: PromiseSettledResult<void>;
}
/** Flatten only user-visible text blocks; reasoning and tool payloads never cross this boundary. */
export declare function textFromContentBlocks(blocks: readonly ContentBlock[]): string;
/** Defensive enforcement of the provider seam's documented 4096-byte diagnostic limit. */
export declare function boundedProviderDiagnostic(value: string | undefined): string | undefined;
export declare function describeAbnormalResult(result: SubagentResult): string;
/**
 * Settle result first, then unconditionally await disposal. The two outcomes
 * remain independent so teardown can neither hide execution failure nor turn
 * a failed cleanup into success/cancellation.
 */
export declare function settlePublishedCodexRun(run: SubagentRun): Promise<CodexRunSettlement>;
export declare function classifyPublishedSettlement(settlement: Awaited<ReturnType<typeof settlePublishedCodexRun>>, signal: AbortSignal): SubagentResult;
//# sourceMappingURL=lifecycle.d.ts.map