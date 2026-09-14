import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent';
export interface ContinuationTurnResult {
    readonly childId: string;
    readonly stopReason: SubagentStopReason;
    readonly finalText: string;
    readonly rawOutput: ContentBlock[];
}
export interface ContinuationTransportOptions {
    quiescenceTimeoutMs?: number;
}
export declare class ContinuationTransportAdapter {
    private readonly ctx;
    private readonly quiescenceTimeoutMs;
    private readonly settledRunIds;
    constructor(ctx: Context, options?: ContinuationTransportOptions);
    /**
     * Start a new continuable child and return immediately after inbox acceptance with an awaitSettlement function.
     */
    startChild(options: {
        provider: string;
        label: string;
        promptText: string;
        parent: Agent;
        signal: AbortSignal;
    }): Promise<{
        childId: string;
        awaitSettlement: () => Promise<ContinuationTurnResult>;
    }>;
    /**
     * Start a new continuable child and await correlated settlement of its initial turn.
     */
    startChildAndTurn(options: {
        provider: string;
        label: string;
        promptText: string;
        parent: Agent;
        signal: AbortSignal;
    }): Promise<ContinuationTurnResult>;
    /**
     * Send a follow-up turn prompt and return an awaitSettlement function.
     */
    sendFollowup(options: {
        parent: Agent;
        childId: string;
        promptText: string;
        signal: AbortSignal;
    }): Promise<() => Promise<ContinuationTurnResult>>;
    /**
     * Send a follow-up turn prompt to an existing continuable child and await correlated settlement.
     */
    sendFollowupTurn(options: {
        parent: Agent;
        childId: string;
        promptText: string;
        signal: AbortSignal;
    }): Promise<ContinuationTurnResult>;
    /**
     * Correlate child turn settlement via subagent/end event with cancel/interrupt handling.
     */
    private awaitChildTurnSettlement;
    drainChild(parent: Agent, childId: string): Promise<void>;
}
//# sourceMappingURL=transport.d.ts.map