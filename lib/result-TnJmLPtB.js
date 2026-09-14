import { randomUUID } from "node:crypto";
//#region lib/types/errors.js
const CONTEXT_DELEGATION_ERROR_CODES = [
	"WORKSPACE_NOT_FOUND",
	"INVALID_INPUT",
	"CONTEXT_READ_ERROR",
	"CONTEXT_PATH_ESCAPE",
	"CONTEXT_TOO_LARGE",
	"CODEX_PROVIDER_NOT_FOUND",
	"CODEX_DELEGATION_FAILED",
	"CODEX_CANCELLED",
	"PLUGIN_INTERNAL_ERROR",
	"UNSUPPORTED_CONTINUATION_PROVIDER",
	"DELEGATION_BUSY",
	"SESSION_LIMIT_REACHED",
	"SESSION_EXPIRED",
	"SESSION_INVALIDATED",
	"DELTA_APPLICATION_FAILED",
	"SNAPSHOT_TOO_LARGE",
	"CONTEXT_ACK_FAILED",
	"CONTEXT_REVISION_MISMATCH"
];
/** Stable, operator-actionable failure raised by the plugin. */
var ContextDelegationError = class extends Error {
	code;
	details;
	constructor(code, message, details, options) {
		super(`[${code}] ${message}`, options);
		this.name = "ContextDelegationError";
		this.code = code;
		this.details = Object.freeze({ ...details });
	}
};
//#endregion
//#region lib/types/observability/trace.js
/**
* Process-local delegation tracing (roadmap V0.7). Traces carry ONLY
* plugin-generated metadata — never executor final text, verification
* output, evidence file names, review reasons, error payloads, or reasoning.
* Retention is a bounded ring buffer; nothing is persisted to disk.
*/
const TRACE_RETENTION = 20;
const MAX_TASK_PREFIX_CHARS = 200;
const ring = [];
function startDelegationTrace(options) {
	const startedAt = Date.now();
	const trace = {
		traceId: randomUUID(),
		taskId: options.task.slice(0, MAX_TASK_PREFIX_CHARS),
		executor: options.executor,
		...options.reviewer === void 0 ? {} : { reviewer: options.reviewer },
		contextMode: "single",
		selectedContextChars: 0,
		startedAt,
		events: []
	};
	const mutableEvents = trace.events;
	const push = (event) => {
		mutableEvents.push(event);
	};
	return {
		traceId: trace.traceId,
		record(stage, detail) {
			push({
				stage,
				atMs: Date.now() - startedAt,
				...detail === void 0 ? {} : { detail }
			});
		},
		setSelectedContextChars(chars) {
			trace.selectedContextChars = chars;
		},
		finish(outcome, fields) {
			trace.outcome = outcome;
			trace.finishedAt = Date.now();
			if (fields?.contextRevision !== void 0) trace.contextRevision = fields.contextRevision;
			if (fields?.contextMode !== void 0) trace.contextMode = fields.contextMode;
			ring.push(trace);
			while (ring.length > 20) ring.shift();
		}
	};
}
/** The most recent traces (bounded); the newest is last. */
function recentDelegationTraces() {
	return ring;
}
//#endregion
//#region lib/types/delegation/result.js
const CODEX_EXPERT_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		success: {
			type: "boolean",
			const: true,
			required: true
		},
		provider: {
			type: "string",
			required: true
		},
		workspaceRoot: {
			type: "string",
			required: true
		},
		contextFilesLoaded: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		contextFilesMissing: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		contextFilesTruncated: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		contextChars: {
			type: "number",
			required: true
		},
		runId: {
			type: "string",
			required: true
		},
		codexFinal: {
			type: "string",
			required: true
		},
		parentVerificationRequired: {
			type: "boolean",
			const: true,
			required: true
		},
		contextWarning: { type: "string" },
		diagnostic: { type: "string" },
		continuation: {
			type: "object",
			additionalProperties: false,
			properties: {
				reused: {
					type: "boolean",
					required: true
				},
				delegationKey: {
					type: "string",
					required: true
				},
				contextMode: {
					type: "string",
					enum: [
						"full",
						"delta",
						"full-refresh"
					],
					required: true
				},
				revision: {
					type: "string",
					required: true
				},
				baseRevision: { type: "string" },
				refreshReason: { type: "string" },
				handoffBytes: {
					type: "number",
					required: true
				}
			}
		},
		review: {
			type: "object",
			additionalProperties: false,
			properties: {
				outcome: {
					type: "string",
					enum: [
						"completed",
						"rework",
						"blocked"
					],
					required: true
				},
				rounds: {
					type: "number",
					required: true
				},
				executorAttempts: {
					type: "number",
					required: true
				},
				finalExecutorReport: {
					type: "object",
					additionalProperties: false,
					properties: {
						status: {
							type: "string",
							enum: [
								"completed",
								"blocked",
								"failed"
							],
							required: true
						},
						summary: {
							type: "string",
							required: true
						},
						filesChanged: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						verification: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									command: {
										type: "string",
										required: true
									},
									outcome: {
										type: "string",
										enum: [
											"passed",
											"failed",
											"not-run"
										],
										required: true
									},
									evidence: { type: "string" }
								}
							},
							required: true
						},
						risks: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						trustNotes: {
							type: "array",
							items: { type: "string" }
						}
					},
					required: true
				},
				workspaceEvidence: {
					type: "object",
					additionalProperties: false,
					properties: {
						available: {
							type: "boolean",
							required: true
						},
						reason: { type: "string" },
						filesChanged: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						diffSummary: { type: "string" }
					},
					required: true
				},
				verification: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							command: {
								type: "string",
								required: true
							},
							outcome: {
								type: "string",
								enum: [
									"passed",
									"failed",
									"not-run"
								],
								required: true
							},
							exitCode: { type: "number" },
							timedOut: {
								type: "boolean",
								required: true
							},
							evidence: {
								type: "string",
								required: true
							}
						}
					},
					required: true
				},
				reviews: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							verdict: {
								type: "string",
								enum: [
									"pass",
									"rework",
									"blocked"
								],
								required: true
							},
							reasons: {
								type: "array",
								items: { type: "string" },
								required: true
							},
							unmetCriteria: {
								type: "array",
								items: { type: "string" },
								required: true
							},
							suspiciousClaims: {
								type: "array",
								items: { type: "string" },
								required: true
							},
							recommendedNextAction: { type: "string" },
							trustNotes: {
								type: "array",
								items: { type: "string" }
							}
						}
					},
					required: true
				},
				reworkLimitReached: { type: "boolean" }
			}
		}
	}
};
function reviewStatusLine(value) {
	const review = value.review;
	if (review === void 0) return `Status: success (provider: ${value.provider}, run: ${value.runId})`;
	const suffix = `provider: ${value.provider}, run: ${value.runId}, executor attempts: ${review.executorAttempts}, review rounds: ${review.rounds}`;
	if (review.outcome === "blocked") return `Status: BLOCKED (${suffix})`;
	if (review.outcome === "rework") return `Status: REWORK (${suffix})`;
	return `Status: success (provider: ${value.provider}, run: ${value.runId})`;
}
/** Concise model-facing rendering of a canonical successful delegation. */
function renderCodexExpertResult(value) {
	const loaded = value.contextFilesLoaded.length === 0 ? "(none)" : value.contextFilesLoaded.join(", ");
	const missing = value.contextFilesMissing.length === 0 ? "(none)" : value.contextFilesMissing.join(", ");
	const truncated = value.contextFilesTruncated.length === 0 ? "(none)" : value.contextFilesTruncated.join(", ");
	const continuationSection = value.continuation === void 0 ? [] : [
		"",
		"## Continuation",
		`Key: ${value.continuation.delegationKey} (${value.continuation.reused ? "reused" : "initial"}, mode: ${value.continuation.contextMode})`,
		`Revision: ${value.continuation.revision}`,
		`Payload: ${value.continuation.handoffBytes} bytes${value.continuation.refreshReason ? ` (${value.continuation.refreshReason})` : ""}`
	];
	const writeback = value.contextWriteback;
	const writebackSection = writeback === void 0 ? [] : [
		"",
		`## Context Write-Back (${writeback.mode}: ${writeback.status})`,
		...writeback.patches.length > 0 ? ["Proposed patches:", ...writeback.patches.map((patch) => `- [${patch.target}] ${patch.operation} ${patch.headingPath.length > 0 ? patch.headingPath.join(" > ") : "(end of file)"} — ${patch.reason}`)] : ["No patches."],
		...writeback.fingerprintAfter !== void 0 ? [`Fingerprint: ${writeback.fingerprintBefore} → ${writeback.fingerprintAfter}`] : [],
		...writeback.reason === void 0 ? [] : [`Note: ${writeback.reason}`],
		...writeback.status === "proposed" ? ["These are PROPOSALS only; no context file was modified by the plugin."] : []
	];
	const review = value.review;
	const reviewSection = review === void 0 ? [] : [
		"",
		`## Review (${review.outcome})`,
		`Executor report status: ${review.finalExecutorReport.status}`,
		`Executor claims filesChanged: ${review.finalExecutorReport.filesChanged.length === 0 ? "(none)" : review.finalExecutorReport.filesChanged.join(", ")}`,
		`Independently observed changed files: ${review.workspaceEvidence.available ? review.workspaceEvidence.filesChanged.length === 0 ? "(none)" : review.workspaceEvidence.filesChanged.join(", ") : `unavailable (${review.workspaceEvidence.reason ?? "unknown"})`}`,
		...review.verification.length > 0 ? ["Independent verification:", ...review.verification.map((entry) => `- [${entry.outcome}] ${entry.command}${entry.timedOut ? " (timed out)" : ""}${entry.evidence ? ` — ${(entry.evidence.split("\n")[0] ?? "").slice(0, 200)}` : ""}`)] : [],
		...review.reviews.flatMap((entry, index) => [
			`Reviewer verdict (round ${index + 1}): ${entry.verdict}`,
			...entry.reasons.length > 0 ? [`  Reasons: ${entry.reasons.join("; ")}`] : [],
			...entry.unmetCriteria.length > 0 ? [`  Unmet criteria: ${entry.unmetCriteria.join("; ")}`] : [],
			...entry.suspiciousClaims.length > 0 ? [`  Suspicious claims: ${entry.suspiciousClaims.join("; ")}`] : []
		]),
		...review.outcome === "blocked" ? [
			"",
			"CRITICAL REVIEW OUTCOME: BLOCKED.",
			"This delegation ended BLOCKED. Do NOT treat it as a successful completion. The parent agent MUST NOT declare [STATUS: VERIFIED]; inspect the reported reasons before doing anything else."
		] : [],
		...review.outcome === "rework" ? [
			"",
			"CRITICAL REVIEW OUTCOME: REWORK REQUIRED.",
			`The rework limit (${review.reviews.length - 1} automatic rework(s)) was reached without a pass from the independent reviewer.`,
			"The parent agent MUST NOT output [STATUS: VERIFIED]. If manual verification was conducted, report it strictly as conditional manual acceptance and do NOT override the independent reviewer verdict."
		] : []
	];
	return [
		"# Codex Expert Result",
		"",
		reviewStatusLine(value),
		...continuationSection,
		"",
		"## Context Loaded",
		`${loaded} (${value.contextChars} characters)`,
		"",
		"## Missing",
		missing,
		"",
		"## Truncated",
		truncated,
		...value.contextWarning === void 0 ? [] : [
			"",
			"## Context Warning",
			value.contextWarning
		],
		...value.diagnostic === void 0 ? [] : [
			"",
			"## Provider Diagnostic",
			value.diagnostic
		],
		...reviewSection,
		...writebackSection,
		"",
		"## Codex Final Result",
		value.codexFinal,
		"",
		"## Parent Verification Required",
		review !== void 0 && (review.outcome === "rework" || review.outcome === "blocked") ? `CRITICAL: The independent reviewer outcome is ${review.outcome.toUpperCase()}. Do NOT output [STATUS: VERIFIED]. The parent agent must honestly report the review failure/rework state.` : "The parent agent must independently verify file changes, tests, and reported metrics."
	].join("\n");
}
//#endregion
export { startDelegationTrace as a, recentDelegationTraces as i, renderCodexExpertResult as n, CONTEXT_DELEGATION_ERROR_CODES as o, TRACE_RETENTION as r, ContextDelegationError as s, CODEX_EXPERT_RESULT_SCHEMA as t };
