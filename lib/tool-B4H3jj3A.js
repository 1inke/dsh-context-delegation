import { i as recentDelegationTraces, n as renderCodexExpertResult, s as ContextDelegationError, t as CODEX_EXPERT_RESULT_SCHEMA } from "./result-TnJmLPtB.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/observability/debug.js
/**
* The observability tool (roadmap V0.7 / §9): safe delegation metadata only.
* No delegation is started, no provider is touched, no file is read.
*/
function createDelegationDebugTool(ctx) {
	return defineTool({
		name: "delegation_debug",
		description: "Inspect this plugin's recent delegation metadata: routed executors, context revisions, stage timings, and outcomes. Contains no executor transcripts, verification output, or reasoning. Note: in trace objects, \"contextMode\" indicates the continuation payload mode (\"single\" | \"full\" | \"delta\"), while configured context engine mode is exposed in \"contextConfigMode\" (\"lexical\" | \"legacy\").",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute() {
			const config = ctx.codexContextDelegation.config;
			return JSON.parse(JSON.stringify({
				service: "codexContextDelegation",
				contractVersion: 1,
				contextConfigMode: config.contextMode,
				routing: {
					implementation: config.executorRouting.implementation.provider,
					reviewer: config.executorRouting.reviewer.provider
				},
				continuationEnabled: config.continuationEnabled,
				contextWriteback: config.contextWriteback,
				traceRetention: 20,
				traces: recentDelegationTraces()
			}));
		}
	});
}
//#endregion
//#region lib/types/tool.js
const name = "dsh-context-delegation-tool";
const inject = ["tools", "codexContextDelegation"];
const CODEX_EXPERT_PARAMETERS = {
	task: {
		type: "string",
		required: true,
		description: "A precise, self-contained coding task for Codex. Persistent repository context is added automatically."
	},
	relevant_files: {
		type: "array",
		items: { type: "string" },
		description: "Optional workspace-relative paths Codex should inspect first. Paths are validated but file contents are not injected."
	},
	acceptance_criteria: {
		type: "array",
		items: { type: "string" },
		description: "Objective conditions that must be true when the delegated task is complete. When provided (fresh mode only), the plugin independently collects workspace evidence, executes verification_commands itself, and runs a fresh independent reviewer with a bounded rework loop."
	},
	verification_commands: {
		type: "array",
		items: { type: "string" },
		description: "Caller-authorized verification commands (max 10). ONLY these are executed independently by the plugin during review; executor-claimed commands are never executed. Denied patterns (privilege escalation, destructive, remote-execution, network-install, git push) are recorded as not-run."
	},
	notes: {
		type: "string",
		description: "Optional task-specific constraints or clarification."
	},
	mode: {
		type: "string",
		enum: ["fresh", "continue"],
		description: "Delegation mode: \"fresh\" (default, independent subagent) or \"continue\" (stateful session continuation)."
	},
	delegation_key: {
		type: "string",
		description: "Unique session key required when mode is \"continue\" (1-64 alphanumeric characters, ., -, _)."
	}
};
const ALLOWED_INPUT_KEYS = new Set(Object.keys(CODEX_EXPERT_PARAMETERS));
const DELEGATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
* DSH's parameter-root schema is intentionally open. Reject undeclared keys at
* execution time so callers cannot appear to override provider, model,
* permission, context-path, or budget configuration.
*/
function assertDelegationInput(input, toolName = "codex_expert") {
	const unexpected = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key)).sort();
	if (unexpected.length > 0) throw new Error(`${toolName} does not accept input field(s): ${unexpected.join(", ")}`);
	if (!input.task || input.task.trim().length === 0) throw new Error(`${toolName} requires a non-empty task`);
	const mode = input.mode ?? "fresh";
	if (mode !== "fresh" && mode !== "continue") throw new Error(`${toolName} mode must be "fresh" or "continue"`);
	if (mode === "fresh" && input.delegation_key !== void 0) throw new Error(`${toolName} does not accept delegation_key when mode is "fresh"`);
	if (mode === "continue") {
		if (!input.delegation_key || typeof input.delegation_key !== "string") throw new Error(`${toolName} requires delegation_key when mode is "continue"`);
		if (!DELEGATION_KEY_PATTERN.test(input.delegation_key)) throw new Error(`${toolName} delegation_key must be 1-64 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`);
	}
}
/** Create the one scoped, foreground-only model-facing tool definition. */
function createCodexExpertTool(ctx) {
	const toolName = ctx.codexContextDelegation.config.toolName;
	return defineTool({
		name: toolName,
		description: "Delegate a focused repository coding task to the configured Codex expert. The plugin automatically loads bounded persistent project context and validates relevant file paths. This is a foreground call: wait for its result, then independently verify all reported changes and tests. CRITICAL: If the review outcome is REWORK or BLOCKED, the caller MUST NOT state [STATUS: VERIFIED]; report the unfulfilled review outcome and next action.",
		parameters: CODEX_EXPERT_PARAMETERS,
		output: {
			schema: CODEX_EXPERT_RESULT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: renderCodexExpertResult(value)
			}]
		},
		async execute(args, exec) {
			assertDelegationInput(args, toolName);
			const parent = exec.agent;
			if (parent === void 0) throw new ContextDelegationError("WORKSPACE_NOT_FOUND", `${toolName} requires an Agent-backed calling session.`, {
				layer: "workspace",
				codexInvoked: false,
				workspaceMayHaveChanged: false,
				nextAction: `Call ${toolName} from an active DSH Agent session with a workspace.`
			});
			return ctx.codexContextDelegation.delegate(args, {
				parent,
				signal: exec.signal
			});
		}
	});
}
/** Register the delegation tool plus the observability tool; Host stays non-model-facing. */
function apply(ctx) {
	ctx.tools.register(createCodexExpertTool(ctx));
	ctx.tools.register(createDelegationDebugTool(ctx));
}
//#endregion
export { inject as a, createCodexExpertTool as i, apply as n, name as o, assertDelegationInput as r, createDelegationDebugTool as s, CODEX_EXPERT_PARAMETERS as t };
