import type { DelegationInput, ContextBundle } from '../types.ts';
export declare const HANDOFF_SECTION_ORDER: readonly ["Repository", "Persistent Project Rules", "Project Context", "Current State", "Relevant Decisions", "Relevant Experiment Evidence", "Delegation Rules", "Task", "Relevant Files", "Acceptance Criteria", "Verification Commands", "Additional Notes", "Required Return"];
export declare const HANDOFF_PAYLOAD_BEGIN = "---BEGIN DSH CODEX HANDOFF JSON V1---";
export declare const HANDOFF_PAYLOAD_END = "---END DSH CODEX HANDOFF JSON V1---";
export declare const HANDOFF_PAYLOAD_V2_BEGIN = "---BEGIN DSH CODEX HANDOFF JSON V2---";
export declare const HANDOFF_PAYLOAD_V2_END = "---END DSH CODEX HANDOFF JSON V2---";
export type HandoffSectionName = typeof HANDOFF_SECTION_ORDER[number];
export interface HandoffBuildRequest {
    readonly input: DelegationInput;
    readonly context: ContextBundle;
    /** Validated workspace-relative paths from the context engine, never raw model input. */
    readonly relevantFiles: readonly string[];
}
export interface HandoffBuilder {
    build(request: HandoffBuildRequest): string;
}
/** Build the deterministic, self-contained prompt for one fresh delegation run. */
export declare function buildDelegationHandoff(request: HandoffBuildRequest): string;
/** @deprecated Use `buildDelegationHandoff`. */
export declare const buildCodexHandoff: typeof buildDelegationHandoff;
export declare const defaultHandoffBuilder: HandoffBuilder;
//# sourceMappingURL=builder.d.ts.map