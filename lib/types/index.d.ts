import { ContextDelegationService } from './delegation/service.ts';
export declare const name = "dsh-context-delegation-host";
declare module '@deepseek-ai/cordis' {
    interface Context {
        codexContextDelegation: ContextDelegationService;
    }
}
export { ContextDelegationService };
export default ContextDelegationService;
export { Config, DEFAULT_CONTEXT_DELEGATION_CONFIG, MAX_CONTEXT_CHARS_HARD_LIMIT, resolveConfig } from './config.ts';
export { chunkContext } from './context/chunker.ts';
export { buildContextQuery, tokenizeContext } from './context/query.ts';
export { rankContextChunks } from './context/retrieval.ts';
export { selectContext } from './context/selection.ts';
export { buildContextPreview } from './context/preview.ts';
export type { ContextChunk, ScoredContextChunk, ContextQuery, ContextSelection, ContextBudgets, ContextPreview } from './types.ts';
export { CONTEXT_DELEGATION_ERROR_CODES, ContextDelegationError, } from './errors.ts';
export type { ContextDelegationErrorCode, ContextDelegationErrorDetails, ContextDelegationLayer, } from './errors.ts';
export { createContextFilePlan, DEFAULT_TRUNCATION_NOTICE, loadPersistentContext, } from './context/loader.ts';
export type { ContextFilePlanEntry, ContextLoader } from './context/loader.ts';
export { budgetContextFiles, normalizeContextText } from './context/budget.ts';
export { normalizeRelativePath, resolveWorkspaceTarget, validateRelevantFiles } from './context/path-confinement.ts';
export { HANDOFF_PAYLOAD_V3_BEGIN, HANDOFF_PAYLOAD_V3_END, buildContinuationHandoff, extractContextAck, parseContinuationHandoff, selectContinuationPayload, } from './handoff/protocol.ts';
export type { ContinuationHandoffPayload } from './handoff/protocol.ts';
export { buildContextSnapshot, computeContentHash, computePolicyRevision, computeSha256, computeUnitId, createSnapshotUnit, } from './context/fingerprint.ts';
export { applyContextDelta, diffContextSnapshots, } from './context/delta.ts';
export { DelegationSessionRegistry, } from './delegation/session.ts';
export type { DelegationSessionRecord, DelegationSessionState, SessionAcquisitionTurn, } from './delegation/session.ts';
export { ContinuationTransportAdapter, } from './delegation/transport.ts';
export type { ContinuationTurnResult, } from './delegation/transport.ts';
export { buildDelegationHandoff, buildCodexHandoff, defaultHandoffBuilder, HANDOFF_PAYLOAD_BEGIN, HANDOFF_PAYLOAD_END, HANDOFF_PAYLOAD_V2_BEGIN, HANDOFF_PAYLOAD_V2_END, HANDOFF_SECTION_ORDER, } from './handoff/builder.ts';
export type { HandoffBuilder, HandoffBuildRequest, HandoffSectionName } from './handoff/builder.ts';
export { EXECUTOR_REPORT_FENCE, parseExecutorReport } from './verification/executor-report.ts';
export { collectWorkspaceEvidence } from './verification/workspace-evidence.ts';
export { isDeniedCommand, runVerificationCommands, VERIFICATION_DENY_PATTERNS } from './verification/verification-runner.ts';
export { buildReviewerPrompt, parseReviewReport, REVIEW_REPORT_FENCE } from './verification/reviewer.ts';
export { hasReviewRequest } from './verification/review-loop.ts';
export { CHUNK_CACHE_MAX_ENTRIES, CHUNK_CACHE_PROTOCOL_VERSION, chunkCacheStats, clearChunkCache } from './context/cache.ts';
export { recentDelegationTraces, startDelegationTrace, TRACE_RETENTION } from './observability/trace.ts';
export { buildContextPatches, applyContextPatches, computeContextFingerprint } from './context/writeback.ts';
export type { DelegationTrace, DelegationTraceEvent, TraceStage, ContextDecisionProposal, ContextExperimentProposal, ContextPatch, ContextUpdateProposal, ContextWritebackMode, ContextWritebackOutcome, ExecutorReport, ReviewReport, ReviewedDelegationOutcome, ReviewVerdict, VerificationClaim, VerificationEvidence, WorkspaceEvidence, } from './types.ts';
export { boundedProviderDiagnostic, describeAbnormalResult, MAX_FAILURE_PARTIAL_CHARS, MAX_PROVIDER_DIAGNOSTIC_BYTES, settlePublishedCodexRun, textFromContentBlocks, } from './delegation/lifecycle.ts';
export type { CodexRunSettlement } from './delegation/lifecycle.ts';
export { CODEX_EXPERT_RESULT_SCHEMA, renderCodexExpertResult } from './delegation/result.ts';
export type { BudgetedContext, DelegationInput, DelegationResult, ContextBudgetPolicy, ContextBundle, ContextCandidate, ContextDelegationConfig, ContextDelegationServiceDescription, ContextDelta, ContextFileId, ContextLoadRequest, ContextLoadResult, ContextSnapshot, ContextSnapshotUnit, ContinuationMetadata, DelegationExecution, LoadedContextFile, LoadPersistentContextRequest, ResolvedContextDelegationConfig, ValidateRelevantFilesRequest, } from './types.ts';
//# sourceMappingURL=index.d.ts.map