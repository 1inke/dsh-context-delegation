import { s as ContextDelegationError } from "./result-TnJmLPtB.js";
import { r as assertDelegationInput, t as CODEX_EXPERT_PARAMETERS } from "./tool-B4H3jj3A.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/preview.js
const name = "dsh-context-delegation-preview";
const inject = ["tools", "codexContextDelegation"];
/** Optional scoped entry; does not change existing ./tool registration. */
function apply(ctx) {
	ctx.tools.register(defineTool({
		name: "context_preview",
		description: "Preview task-relevant persistent context headings, scores and budget usage. Reads context only; never invokes an executor or writes workspace files.",
		parameters: CODEX_EXPERT_PARAMETERS,
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args, exec) {
			assertDelegationInput(args, "context_preview");
			if (!exec.agent) throw new ContextDelegationError("WORKSPACE_NOT_FOUND", "context_preview requires an Agent-backed session.", {
				layer: "workspace",
				codexInvoked: false,
				workspaceMayHaveChanged: false,
				nextAction: "Use an active DSH Agent session with a workspace."
			});
			return JSON.stringify(await ctx.codexContextDelegation.preview(args, {
				parent: exec.agent,
				signal: exec.signal
			}), null, 2);
		}
	}));
}
//#endregion
export { apply, inject, name };
