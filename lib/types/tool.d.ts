import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { DelegationInput } from './types.ts';
export { createDelegationDebugTool } from './observability/debug.ts';
export declare const name = "dsh-context-delegation-tool";
export declare const inject: string[];
export declare const CODEX_EXPERT_PARAMETERS: {
    readonly task: {
        readonly type: "string";
        readonly required: true;
        readonly description: "A precise, self-contained coding task for Codex. Persistent repository context is added automatically.";
    };
    readonly relevant_files: {
        readonly type: "array";
        readonly items: {
            readonly type: "string";
        };
        readonly description: "Optional workspace-relative paths Codex should inspect first. Paths are validated but file contents are not injected.";
    };
    readonly acceptance_criteria: {
        readonly type: "array";
        readonly items: {
            readonly type: "string";
        };
        readonly description: string;
    };
    readonly verification_commands: {
        readonly type: "array";
        readonly items: {
            readonly type: "string";
        };
        readonly description: string;
    };
    readonly notes: {
        readonly type: "string";
        readonly description: "Optional task-specific constraints or clarification.";
    };
    readonly mode: {
        readonly type: "string";
        readonly enum: readonly ["fresh", "continue"];
        readonly description: "Delegation mode: \"fresh\" (default, independent subagent) or \"continue\" (stateful session continuation).";
    };
    readonly delegation_key: {
        readonly type: "string";
        readonly description: "Unique session key required when mode is \"continue\" (1-64 alphanumeric characters, ., -, _).";
    };
};
/**
 * DSH's parameter-root schema is intentionally open. Reject undeclared keys at
 * execution time so callers cannot appear to override provider, model,
 * permission, context-path, or budget configuration.
 */
export declare function assertDelegationInput(input: DelegationInput, toolName?: string): void;
/** Create the one scoped, foreground-only model-facing tool definition. */
export declare function createCodexExpertTool(ctx: Context): ToolDefinition;
/** Register the delegation tool plus the observability tool; Host stays non-model-facing. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=tool.d.ts.map