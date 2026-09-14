import { defineTool } from '@deepseek-ai/dsh-tools';
import { recentDelegationTraces, TRACE_RETENTION } from "./trace.js";
/**
 * The observability tool (roadmap V0.7 / §9): safe delegation metadata only.
 * No delegation is started, no provider is touched, no file is read.
 */
export function createDelegationDebugTool(ctx) {
    return defineTool({
        name: 'delegation_debug',
        description: 'Inspect this plugin\'s recent delegation metadata: routed executors, context revisions, '
            + 'stage timings, and outcomes. Contains no executor transcripts, verification output, or reasoning. '
            + 'Note: in trace objects, "contextMode" indicates the continuation payload mode ("single" | "full" | "delta"), '
            + 'while configured context engine mode is exposed in "contextConfigMode" ("lexical" | "legacy").',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute() {
            const config = ctx.codexContextDelegation.config;
            return JSON.parse(JSON.stringify({
                service: 'codexContextDelegation',
                contractVersion: 1,
                contextConfigMode: config.contextMode,
                routing: {
                    implementation: config.executorRouting.implementation.provider,
                    reviewer: config.executorRouting.reviewer.provider,
                },
                continuationEnabled: config.continuationEnabled,
                contextWriteback: config.contextWriteback,
                traceRetention: TRACE_RETENTION,
                traces: recentDelegationTraces(),
            }));
        },
    });
}
//# sourceMappingURL=debug.js.map