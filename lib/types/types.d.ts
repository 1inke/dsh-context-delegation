import type { Agent } from '@deepseek-ai/dsh-agent';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
/** Default truncation notice appended to truncated persistent context files (72 UTF-16 code units). */
export declare const DEFAULT_TRUNCATION_NOTICE = "\n\n[... truncated by dsh-context-delegation: maxContextChars reached ...]";
/** Public configuration accepted by the Host service. */
export interface ContextDelegationConfig {
    /** Operator-owned retrieval mode; legacy preserves the V0.1 serial loader. */
    contextMode?: 'lexical' | 'legacy';
    contextMinRelativeScore?: number;
    contextBudgets?: Partial<ContextBudgets>;
    providerName?: string;
    toolName?: string;
    contextRoot?: string;
    maxContextChars?: number;
    includeAgents?: boolean;
    includeProjectContext?: boolean;
    includeCurrentState?: boolean;
    includeDecisions?: boolean;
    includeExperiments?: boolean;
    includeHandoffRules?: boolean;
    continuationEnabled?: boolean;
    continuationProviderName?: string;
    requireContextAck?: boolean;
    maxSessions?: number;
    idleTtlMs?: number;
    maxSnapshotBytes?: number;
    maxReviewRounds?: number;
    verificationTimeoutMs?: number;
    verificationMaxOutputChars?: number;
    reviewProviderName?: string;
    executorRouting?: ExecutorRoutingConfig;
    contextWriteback?: ContextWritebackMode;
    cacheEnabled?: boolean;
}
/** Operator-owned routing document (roadmap 5.5). Never model-controlled. */
export interface ExecutorRoute {
    readonly provider?: string;
    readonly model?: string;
}
export interface ExecutorRoutingConfig {
    readonly implementation?: ExecutorRoute;
    readonly reviewer?: ExecutorRoute;
}
export interface ResolvedExecutorRouting {
    readonly implementation: {
        readonly provider: string;
        readonly model?: string;
    };
    readonly reviewer: {
        readonly provider: string;
        readonly model?: string;
    };
}
/** Validated configuration used internally after defaults are applied. */
export interface ResolvedContextDelegationConfig {
    readonly contextMode: 'lexical' | 'legacy';
    readonly contextMinRelativeScore: number;
    readonly contextBudgets: ContextBudgets;
    readonly providerName: string;
    readonly toolName: string;
    readonly contextRoot: string;
    readonly maxContextChars: number;
    readonly includeAgents: boolean;
    readonly includeProjectContext: boolean;
    readonly includeCurrentState: boolean;
    readonly includeDecisions: boolean;
    readonly includeExperiments: boolean;
    readonly includeHandoffRules: boolean;
    readonly continuationEnabled: boolean;
    readonly continuationProviderName: string;
    readonly requireContextAck: boolean;
    readonly maxSessions: number;
    readonly idleTtlMs: number;
    readonly maxSnapshotBytes: number;
    readonly maxReviewRounds: number;
    readonly verificationTimeoutMs: number;
    readonly verificationMaxOutputChars: number;
    readonly reviewProviderName: string;
    readonly executorRouting: ResolvedExecutorRouting;
    readonly contextWriteback: ContextWritebackMode;
    readonly cacheEnabled: boolean;
}
/** Model-controlled input for the future `codex_expert` tool. */
export interface DelegationInput {
    task: string;
    relevant_files?: string[];
    acceptance_criteria?: string[];
    verification_commands?: string[];
    notes?: string;
    mode?: 'fresh' | 'continue';
    delegation_key?: string;
}
/** @deprecated Use `DelegationInput`. */
export type CodexExpertInput = DelegationInput;
export type ContextFileId = 'agents' | 'currentState' | 'projectContext' | 'handoffRules' | 'decisions' | 'experiments';
/** One selected persistent-context file after loading and budgeting. */
export interface LoadedContextFile {
    readonly id: ContextFileId;
    readonly relativePath: string;
    readonly content: string;
    /** Exact normalized source length, or null when bounded reading stopped after proving overflow. */
    readonly originalChars: number | null;
    readonly includedChars: number;
    readonly truncated: boolean;
}
/** Deterministic context payload passed to the handoff builder. */
export interface ContextBundle {
    readonly selection?: ContextSelection;
    readonly workspaceRoot: string;
    readonly files: readonly LoadedContextFile[];
    readonly missingFiles: readonly string[];
    readonly truncatedFiles: readonly string[];
    readonly totalChars: number;
    readonly warning?: string;
}
/** Canonical successful value returned by the future `codex_expert` tool. */
export interface DelegationResult {
    readonly success: true;
    readonly provider: string;
    readonly workspaceRoot: string;
    readonly contextFilesLoaded: string[];
    readonly contextFilesMissing: string[];
    readonly contextFilesTruncated: string[];
    readonly contextChars: number;
    readonly runId: string;
    readonly codexFinal: string;
    readonly parentVerificationRequired: true;
    readonly contextWarning?: string;
    readonly diagnostic?: string;
    readonly continuation?: ContinuationMetadata;
    readonly review?: ReviewedDelegationOutcome;
    readonly contextWriteback?: ContextWritebackOutcome;
}
/** One proposed decision for DECISIONS.md (rationale required). */
export interface ContextDecisionProposal {
    readonly decision: string;
    readonly rationale?: string;
}
/** One proposed experiment entry (executed command + result required). */
export interface ContextExperimentProposal {
    readonly experiment: string;
    readonly command?: string;
    readonly result?: string;
    readonly conclusion?: string;
}
/** Executor-proposed context update, inside its structured report. */
export interface ContextUpdateProposal {
    readonly currentState?: readonly string[];
    readonly projectContext?: readonly string[];
    readonly decisions?: readonly ContextDecisionProposal[];
    readonly experiments?: readonly ContextExperimentProposal[];
}
/** One auditable, policy-checked context modification. */
export interface ContextPatch {
    readonly target: 'CURRENT_STATE' | 'PROJECT_CONTEXT' | 'DECISIONS' | 'EXPERIMENTS';
    readonly operation: 'append-section' | 'replace-section';
    readonly headingPath: readonly string[];
    readonly content: string;
    readonly reason: string;
}
export type ContextWritebackMode = 'disabled' | 'proposal' | 'apply';
/** Write-back outcome attached to the delegation result. */
export interface ContextWritebackOutcome {
    readonly mode: 'disabled' | 'proposal' | 'apply';
    readonly status: 'proposed' | 'applied' | 'failed' | 'dropped';
    readonly patches: ContextPatch[];
    readonly fingerprintBefore?: string;
    readonly fingerprintAfter?: string;
    readonly reason?: string;
}
/** One verification command the EXECUTOR claims to have run. Data, never evidence. */
export interface VerificationClaim {
    readonly command: string;
    readonly outcome: 'passed' | 'failed' | 'not-run';
    readonly evidence?: string;
}
/** Structured self-report parsed from the executor's final message. Claims only. */
export interface ExecutorReport {
    readonly status: 'completed' | 'blocked' | 'failed';
    readonly summary: string;
    readonly filesChanged: string[];
    readonly verification: VerificationClaim[];
    readonly risks: string[];
    readonly contextUpdate?: ContextUpdateProposal;
    /** Non-empty when the report was missing, malformed, or coerced. */
    readonly trustNotes?: string[];
}
/** Independently collected workspace state (read-only git), per attempt. */
export interface WorkspaceEvidence {
    readonly available: boolean;
    readonly reason?: string;
    readonly filesChanged: string[];
    readonly diffSummary?: string;
}
/** Result of one caller-authorized verification command run by the plugin. */
export interface VerificationEvidence {
    readonly command: string;
    readonly outcome: 'passed' | 'failed' | 'not-run';
    /** Exit code when the command actually ran; absent for not-run commands. */
    readonly exitCode?: number;
    readonly timedOut: boolean;
    readonly evidence: string;
}
export type ReviewVerdict = 'pass' | 'rework' | 'blocked';
/** Structured reviewer verdict parsed from the reviewer's final message. */
export interface ReviewReport {
    readonly verdict: ReviewVerdict;
    readonly reasons: string[];
    readonly unmetCriteria: string[];
    readonly suspiciousClaims: string[];
    readonly recommendedNextAction?: string;
    /** Non-empty when the review was missing, malformed, or coerced. */
    readonly trustNotes?: string[];
}
/** Aggregate outcome of the bounded reviewed delegation loop. */
export interface ReviewedDelegationOutcome {
    readonly outcome: 'completed' | 'rework' | 'blocked';
    readonly rounds: number;
    readonly executorAttempts: number;
    readonly finalExecutorReport: ExecutorReport;
    readonly workspaceEvidence: WorkspaceEvidence;
    readonly verification: VerificationEvidence[];
    readonly reviews: ReviewReport[];
    readonly reworkLimitReached?: boolean;
}
/** @deprecated Use `DelegationResult`. */
export type CodexExpertSuccess = DelegationResult;
export interface ContinuationMetadata {
    readonly reused: boolean;
    readonly delegationKey: string;
    readonly contextMode: 'full' | 'delta' | 'full-refresh';
    readonly revision: string;
    readonly baseRevision?: string;
    readonly refreshReason?: string;
    readonly handoffBytes: number;
}
export interface ContextSnapshotUnit {
    readonly id: string;
    readonly sourceId: ContextFileId;
    readonly relativePath: string;
    readonly headingPath: readonly string[];
    readonly partIndex: number;
    readonly content: string;
    readonly contentHash: string;
}
export interface ContextSnapshot {
    readonly revision: string;
    readonly policyRevision: string;
    readonly units: readonly ContextSnapshotUnit[];
    readonly missingFiles: readonly string[];
    readonly sourceLimitedFiles: readonly string[];
}
export interface ContextDelta {
    readonly baseRevision: string;
    readonly revision: string;
    readonly policyRevision: string;
    readonly added: readonly ContextSnapshotUnit[];
    readonly changed: readonly ContextSnapshotUnit[];
    readonly removed: readonly {
        readonly id: string;
    }[];
    readonly missingFiles: readonly string[];
    readonly sourceLimitedFiles: readonly string[];
}
export type TraceStage = 'context' | 'executor-start' | 'executor-end' | 'evidence' | 'verification' | 'review' | 'rework' | 'write-back';
export interface DelegationTraceEvent {
    readonly stage: TraceStage;
    readonly atMs: number;
    readonly detail?: Record<string, string | number | boolean | null>;
}
export interface DelegationTrace {
    readonly traceId: string;
    readonly taskId: string;
    readonly executor: string;
    readonly reviewer?: string;
    readonly contextRevision?: string;
    contextMode: 'full' | 'delta' | 'single';
    selectedContextChars: number;
    readonly startedAt: number;
    finishedAt?: number;
    outcome?: 'completed' | 'rework' | 'blocked' | 'failed';
    readonly events: readonly DelegationTraceEvent[];
}
/** Parent-owned execution identity required for one foreground delegation. */
export interface DelegationExecution {
    readonly parent: Agent;
    readonly signal: AbortSignal;
}
/** Non-sensitive Host service status exposed to the scoped loading probe. */
export interface ContextDelegationServiceDescription {
    readonly service: 'codexContextDelegation';
    readonly contractVersion: 1;
    readonly providerName: string;
    readonly toolName: string;
    readonly contextRoot: string;
    readonly maxContextChars: number;
    readonly readyForDelegation: boolean;
}
/** Parameters requesting combined context loading and relevant-files verification. */
export interface ContextLoadRequest {
    readonly workspaceRoot: string;
    readonly relevantFiles: readonly string[];
    readonly signal: AbortSignal;
}
/** Complete output of combined context loading and relevant-files verification. */
export interface ContextLoadResult {
    readonly context: ContextBundle;
    readonly relevantFiles: readonly string[];
}
export interface ContextBudgets {
    readonly mandatory: number;
    readonly project: number;
    readonly decisions: number;
    readonly experiments: number;
}
export interface ContextChunk {
    readonly sourceId: ContextFileId;
    readonly relativePath: string;
    readonly headingPath: readonly string[];
    readonly content: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly partIndex?: number;
}
export interface ScoredContextChunk extends ContextChunk {
    readonly score: number;
    readonly matchedTerms: readonly string[];
}
export interface ContextQuery {
    readonly rawText: string;
    readonly terms: readonly string[];
    readonly relevantFiles: readonly string[];
}
export interface ContextSelection {
    readonly minimumScore: number;
    readonly mandatoryFiles: readonly LoadedContextFile[];
    readonly selectedChunks: readonly ScoredContextChunk[];
    readonly rejectedChunks: readonly ScoredContextChunk[];
    readonly totalChars: number;
    readonly budgetUsage: ContextBudgets;
    readonly budgets: ContextBudgets;
    readonly sourceLimitedFiles: readonly string[];
}
export interface ContextPreview {
    readonly minimumScore?: number;
    readonly task: string;
    readonly mode: 'lexical' | 'legacy';
    readonly totalChars: number;
    readonly maxContextChars: number;
    readonly mandatory: readonly {
        relativePath: string;
        chars: number;
        truncated: boolean;
    }[];
    readonly retrieved: readonly (Omit<ScoredContextChunk, 'content'> & {
        readonly includedChars: number;
    })[];
    readonly rejectedChunkCount: number;
    readonly missingFiles: readonly string[];
    readonly sourceLimitedFiles: readonly string[];
    readonly budgetUsage?: ContextBudgets;
    readonly budgets?: ContextBudgets;
    readonly continuation?: ContinuationMetadata;
}
/** Parameters for loading persistent context files (W2-4). */
export interface LoadPersistentContextRequest {
    readonly fs: FileSystem;
    readonly config: ResolvedContextDelegationConfig;
    readonly workspaceRoot: string;
    readonly signal: AbortSignal;
}
/** Parameters for validating candidate relevant_files paths (W2-3). */
export interface ValidateRelevantFilesRequest {
    readonly fs: FileSystem;
    readonly workspaceRoot: string;
    readonly relevantFiles: readonly string[];
    readonly signal: AbortSignal;
}
/** Context candidate file loaded from workspace, pending budgeting. */
export interface ContextCandidate {
    readonly id: ContextFileId;
    readonly relativePath: string;
    readonly priority: number;
    readonly content: string;
    /** False when content is a bounded prefix of a larger source. Defaults to true. */
    readonly sourceComplete?: boolean;
}
/** Configuration policy governing context text normalization and character budgeting. */
export interface ContextBudgetPolicy {
    readonly maxContextChars: number;
    readonly truncationNotice?: string;
}
/** Result of executing context budgeting across prioritized candidate files. */
export interface BudgetedContext {
    readonly files: readonly LoadedContextFile[];
    readonly truncatedFiles: readonly string[];
    readonly totalChars: number;
}
//# sourceMappingURL=types.d.ts.map