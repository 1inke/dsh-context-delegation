import { Context, Service } from '@deepseek-ai/cordis';
import { Config, resolveConfig } from "../config.js";
import { ContextDelegationError } from "../errors.js";
import { loadContextCandidates, loadPersistentContext } from "../context/loader.js";
import { selectContext } from "../context/selection.js";
import { buildContextPreview } from "../context/preview.js";
import { validateRelevantFiles } from "../context/path-confinement.js";
import { buildDelegationHandoff } from "../handoff/builder.js";
import { ContinuationTransportAdapter } from "./transport.js";
import { DelegationSessionRegistry } from "./session.js";
import { buildContextSnapshot, computePolicyRevision } from "../context/fingerprint.js";
import { selectContinuationPayload, extractContextAck } from "../handoff/protocol.js";
import { finishLoopTrace as finishDelegationTrace, hasReviewRequest, runReviewedDelegation } from "../verification/review-loop.js";
import { startDelegationTrace } from "../observability/trace.js";
import { SubagentExecutor } from "../executors/subagent.js";
export class ContextDelegationService extends Service {
    static inject = ['fs', 'subagents'];
    static Config = Config;
    config;
    transport;
    sessionRegistry;
    constructor(ctx, config = {}) {
        super(ctx, 'codexContextDelegation');
        this.config = resolveConfig(config);
        this.transport = new ContinuationTransportAdapter(ctx);
        this.sessionRegistry = new DelegationSessionRegistry({
            maxSessions: this.config.maxSessions,
            idleTtlMs: this.config.idleTtlMs,
            drainChild: (parent, childId) => this.transport.drainChild(parent, childId),
        });
        this.ctx.effect(() => () => {
            void this.sessionRegistry.drainAll();
        }, 'codexContextDelegation.sessions');
        this.ctx.logger.info(`dsh-context-delegation contract v1 loaded (provider=${this.config.providerName}, `
            + `contextRoot=${this.config.contextRoot}, continuation=${this.config.continuationEnabled})`);
    }
    getSessionRegistry() {
        return this.sessionRegistry;
    }
    /** Report only deployment metadata safe for a model-visible loading probe. */
    describe() {
        return {
            service: 'codexContextDelegation',
            contractVersion: 1,
            providerName: this.config.providerName,
            toolName: this.config.toolName,
            contextRoot: this.config.contextRoot,
            maxContextChars: this.config.maxContextChars,
            readyForDelegation: true,
        };
    }
    /**
     * Prepare context bundle and validate relevant_files for a delegation request.
     * S2-5 Host service integration method; reserved for Block 3 handoff pipeline.
     */
    async prepareContext(input, execution) {
        const parent = execution.parent;
        const signal = execution.signal ?? new AbortController().signal;
        // 1. Authoritative workspace resolution from parent.session.header.cwd
        const workspaceRoot = parent?.session?.header?.cwd;
        if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
            throw new ContextDelegationError('WORKSPACE_NOT_FOUND', 'Calling agent session does not have an authoritative working directory (cwd).', {
                layer: 'workspace',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Ensure the calling agent has an active session with a valid cwd.',
            });
        }
        // 2. Validate model-supplied relevant_files
        const relevantFiles = await validateRelevantFiles({
            fs: this.ctx.fs,
            workspaceRoot,
            relevantFiles: input.relevant_files ?? [],
            signal,
        });
        // 3. Load persistent context files within the authoritative workspace
        const loadRequest = {
            fs: this.ctx.fs,
            config: this.config,
            workspaceRoot,
            signal,
        };
        if (this.config.contextMode === 'legacy') {
            return { context: await loadPersistentContext(loadRequest), relevantFiles };
        }
        const { candidates, missingFiles } = await loadContextCandidates(loadRequest);
        if (signal.aborted)
            throw cancelledBeforeInvocation();
        const selection = selectContext(candidates, input, relevantFiles, this.config);
        const retrievedFiles = candidates.filter(source => ['projectContext', 'decisions', 'experiments'].includes(source.id))
            .map(source => {
            const content = selection.selectedChunks.filter(chunk => chunk.sourceId === source.id)
                .map(chunk => chunk.content).join('');
            return { id: source.id, relativePath: source.relativePath, content,
                originalChars: source.sourceComplete === false ? null : source.content.length,
                includedChars: content.length, truncated: source.sourceComplete === false };
        });
        const context = {
            workspaceRoot, files: [...selection.mandatoryFiles, ...retrievedFiles], missingFiles,
            truncatedFiles: selection.sourceLimitedFiles, totalChars: selection.totalChars, selection,
            ...(candidates.length === 0 ? { warning: 'No persistent context files found in workspace' } : {}),
        };
        return {
            context,
            relevantFiles,
        };
    }
    /** Read-only preview shares the exact preparation path used by delegate(). */
    async preview(input, execution) {
        const isContinue = input.mode === 'continue';
        if (isContinue) {
            if (!this.config.continuationEnabled) {
                throw new ContextDelegationError('UNSUPPORTED_CONTINUATION_PROVIDER', 'Continuation is disabled by configuration (continuationEnabled: false).', {
                    layer: 'provider',
                    codexInvoked: false,
                    workspaceMayHaveChanged: false,
                    nextAction: 'Set continuationEnabled: true or use mode: fresh.',
                });
            }
            if (!input.delegation_key) {
                throw new ContextDelegationError('PLUGIN_INTERNAL_ERROR', 'delegation_key is required when mode is continue.', {
                    layer: 'plugin',
                    codexInvoked: false,
                    workspaceMayHaveChanged: false,
                    nextAction: 'Provide a valid delegation_key for continuation.',
                });
            }
        }
        const prepared = await this.prepareContext(input, execution);
        const basePreview = buildContextPreview(input, prepared.context, this.config);
        if (!isContinue) {
            return basePreview;
        }
        const provider = this.config.continuationProviderName;
        const policyRevision = computePolicyRevision({
            mandatoryFiles: prepared.context.selection?.mandatoryFiles ?? prepared.context.files,
            missingFiles: prepared.context.missingFiles,
            contextRoot: this.config.contextRoot,
            maxContextChars: this.config.maxContextChars,
            protocolVersion: 'dsh-context-delegation/v3',
            includeFlags: {
                includeAgents: this.config.includeAgents,
                includeProjectContext: this.config.includeProjectContext,
                includeCurrentState: this.config.includeCurrentState,
                includeDecisions: this.config.includeDecisions,
                includeExperiments: this.config.includeExperiments,
                includeHandoffRules: this.config.includeHandoffRules,
            },
            budgets: this.config.contextBudgets,
            contextMinRelativeScore: this.config.contextMinRelativeScore,
        });
        const currentSnapshot = buildContextSnapshot({
            bundle: prepared.context,
            policyRevision,
            maxSnapshotBytes: this.config.maxSnapshotBytes,
        });
        const compatibilityKey = JSON.stringify({
            policyRevision: currentSnapshot.policyRevision,
            provider,
        });
        const sessionCheck = execution.parent
            ? this.sessionRegistry.checkSessionCompatibility(execution.parent, input.delegation_key, provider, compatibilityKey)
            : { canReuse: false };
        const reused = sessionCheck.canReuse;
        const baseSnapshot = sessionCheck.baseSnapshot;
        const selectedPayload = selectContinuationPayload({
            baseSnapshot,
            currentSnapshot,
            input,
            relevantFiles: prepared.relevantFiles,
        });
        return {
            ...basePreview,
            continuation: {
                reused,
                delegationKey: input.delegation_key,
                contextMode: selectedPayload.contextMode,
                revision: currentSnapshot.revision,
                ...(selectedPayload.payload.baseRevision ? { baseRevision: selectedPayload.payload.baseRevision } : {}),
                ...(selectedPayload.payload.refreshReason ? { refreshReason: selectedPayload.payload.refreshReason } : {}),
                handoffBytes: selectedPayload.handoffBytes,
            },
        };
    }
    /** Execute one foreground delegation and return only after the child is quiescent. */
    async delegate(input, execution) {
        const { signal } = execution;
        if (signal.aborted)
            throw cancelledBeforeInvocation();
        if (input.mode === 'continue') {
            if (hasReviewRequest(input)) {
                throw new ContextDelegationError('INVALID_INPUT', 'acceptance_criteria with mode "continue" is not supported: the reviewed flow only runs on fresh delegations.', {
                    layer: 'delegation',
                    codexInvoked: false,
                    workspaceMayHaveChanged: false,
                    nextAction: 'Use mode "fresh" for reviewed delegations, or drop acceptance_criteria.',
                });
            }
            return this.delegateContinuation(input, execution);
        }
        const route = this.config.executorRouting;
        const reviewed = hasReviewRequest(input);
        const trace = startDelegationTrace({
            task: input.task,
            executor: route.implementation.provider,
            ...(reviewed ? { reviewer: route.reviewer.provider } : {}),
        });
        if (reviewed) {
            return runReviewedDelegation({
                config: this.config,
                trace,
                runFreshAttempt: (attemptInput, attemptExecution) => this.runFreshAttempt(attemptInput, attemptExecution, trace),
                startReviewer: (promptText, attemptExecution) => this.startReviewer(promptText, attemptExecution),
            }, input, execution);
        }
        try {
            const result = await this.runFreshAttempt(input, execution, trace);
            await finishDelegationTrace({ config: this.config }, trace, result, 'completed');
            return result;
        }
        catch (error) {
            // Infrastructure/config failures finish the trace as 'failed' with the
            // stable code only. Cancellation leaves the trace unfinished: nothing
            // enters the ring buffer for a cancelled call.
            if (error instanceof ContextDelegationError
                && (error.code === 'CODEX_DELEGATION_FAILED' || error.code === 'CODEX_PROVIDER_NOT_FOUND')) {
                trace.record('executor-end', { code: error.code, ok: false });
                await finishDelegationTrace({ config: this.config }, trace, undefined, 'failed');
            }
            throw error;
        }
    }
    /** Run the reviewer as a FRESH one-shot child on the routed reviewer executor. */
    startReviewer(promptText, execution) {
        const route = this.config.executorRouting.reviewer;
        const reviewer = new SubagentExecutor(this.ctx, route.provider, route.model);
        return reviewer.execute({ label: 'Independent review', promptText }, execution);
    }
    /** One unreviewed fresh delegation attempt through the routed executor. */
    async runFreshAttempt(input, execution, trace) {
        const { signal } = execution;
        const route = this.config.executorRouting.implementation;
        const executor = new SubagentExecutor(this.ctx, route.provider, route.model);
        if (!executor.available()) {
            throw providerNotFound(route.provider, false);
        }
        const prepared = await this.prepareContext(input, execution);
        if (signal.aborted)
            throw cancelledBeforeInvocation();
        trace?.record('context', {
            filesLoaded: prepared.context.files.length,
            contextChars: prepared.context.totalChars,
        });
        trace?.setSelectedContextChars(prepared.context.totalChars);
        const handoff = buildDelegationHandoff({
            input,
            context: prepared.context,
            relevantFiles: prepared.relevantFiles,
        });
        trace?.record('executor-start', { executor: route.provider });
        const run = await executor.execute({ label: 'Contextual Codex task', promptText: handoff }, execution);
        trace?.record('executor-end', { runId: run.runId });
        return {
            success: true,
            provider: route.provider,
            workspaceRoot: prepared.context.workspaceRoot,
            contextFilesLoaded: prepared.context.files.map(file => file.relativePath),
            contextFilesMissing: [...prepared.context.missingFiles],
            contextFilesTruncated: [...prepared.context.truncatedFiles],
            contextChars: prepared.context.totalChars,
            runId: run.runId,
            codexFinal: run.finalText,
            parentVerificationRequired: true,
            ...(prepared.context.warning === undefined
                ? {}
                : { contextWarning: prepared.context.warning }),
            ...(run.providerDiagnostic === undefined ? {} : { diagnostic: run.providerDiagnostic }),
        };
    }
    async delegateContinuation(input, execution) {
        const { parent, signal } = execution;
        if (signal.aborted)
            throw cancelledBeforeInvocation();
        if (!this.config.continuationEnabled) {
            throw new ContextDelegationError('UNSUPPORTED_CONTINUATION_PROVIDER', 'Continuation is disabled by configuration (continuationEnabled: false).', {
                layer: 'provider',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Set continuationEnabled: true or use mode: fresh.',
            });
        }
        if (!input.delegation_key || typeof input.delegation_key !== 'string') {
            throw new ContextDelegationError('PLUGIN_INTERNAL_ERROR', 'delegation_key is required when mode is continue.', {
                layer: 'plugin',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Provide a valid delegation_key for continuation.',
            });
        }
        const providerName = this.config.continuationProviderName;
        const providerObj = this.ctx.subagents.getProvider(providerName);
        if (!providerObj) {
            throw providerNotFound(providerName, false);
        }
        if (typeof providerObj.prepareContinuable !== 'function') {
            throw new ContextDelegationError('UNSUPPORTED_CONTINUATION_PROVIDER', `Provider "${providerName}" does not support continuable children (lacks prepareContinuable capability).`, {
                layer: 'provider',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Select a continuable-capable provider (e.g. spawn) or use mode: fresh.',
            });
        }
        const prepared = await this.prepareContext(input, execution);
        if (signal.aborted)
            throw cancelledBeforeInvocation();
        const policyRevision = computePolicyRevision({
            mandatoryFiles: prepared.context.selection?.mandatoryFiles ?? prepared.context.files,
            missingFiles: prepared.context.missingFiles,
            contextRoot: this.config.contextRoot,
            maxContextChars: this.config.maxContextChars,
            protocolVersion: 'dsh-context-delegation/v3',
            includeFlags: {
                includeAgents: this.config.includeAgents,
                includeProjectContext: this.config.includeProjectContext,
                includeCurrentState: this.config.includeCurrentState,
                includeDecisions: this.config.includeDecisions,
                includeExperiments: this.config.includeExperiments,
                includeHandoffRules: this.config.includeHandoffRules,
            },
            budgets: this.config.contextBudgets,
            contextMinRelativeScore: this.config.contextMinRelativeScore,
        });
        const currentSnapshot = buildContextSnapshot({
            bundle: prepared.context,
            policyRevision,
            maxSnapshotBytes: this.config.maxSnapshotBytes,
        });
        const compatibilityKey = JSON.stringify({
            policyRevision: currentSnapshot.policyRevision,
            provider: providerName,
        });
        const plan = await this.sessionRegistry.prepareSessionTurn({
            parent,
            delegationKey: input.delegation_key,
            provider: providerName,
            compatibilityKey,
        });
        let selectedHandoff;
        let turnHandle;
        let awaitSettlement;
        const isReused = plan.mode === 'reuse';
        if (plan.mode === 'reuse') {
            turnHandle = plan.handle;
            selectedHandoff = selectContinuationPayload({
                baseSnapshot: plan.baseSnapshot,
                currentSnapshot,
                input,
                relevantFiles: prepared.relevantFiles,
            });
            try {
                awaitSettlement = await this.transport.sendFollowup({
                    parent,
                    childId: plan.record.childId,
                    promptText: selectedHandoff.handoffText,
                    signal,
                });
            }
            catch (error) {
                await turnHandle.invalidate();
                throw error;
            }
        }
        else {
            selectedHandoff = selectContinuationPayload({
                baseSnapshot: undefined,
                currentSnapshot,
                input,
                relevantFiles: prepared.relevantFiles,
            });
            try {
                const started = await this.transport.startChild({
                    provider: providerName,
                    label: `Contextual delegation [${input.delegation_key}]`,
                    promptText: selectedHandoff.handoffText,
                    parent,
                    signal,
                });
                turnHandle = plan.completeCreation(started.childId);
                awaitSettlement = started.awaitSettlement;
            }
            catch (error) {
                plan.abortCreation();
                throw error;
            }
        }
        turnHandle.setPendingSnapshot(currentSnapshot);
        let turnResult;
        try {
            turnResult = await awaitSettlement();
        }
        catch (error) {
            await turnHandle.invalidate();
            throw error;
        }
        // Verify ACK if configured or if ACK marker is returned
        const ack = extractContextAck(turnResult.finalText);
        if (this.config.requireContextAck) {
            if (!ack.valid) {
                await turnHandle.invalidate();
                throw new ContextDelegationError('CONTEXT_ACK_FAILED', `Continuable turn completed but context revision acknowledgment failed: ${ack.error ?? 'INVALID_ACK'}.`, {
                    layer: 'context',
                    codexInvoked: true,
                    workspaceMayHaveChanged: true,
                    nextAction: 'Ensure child agent acknowledges expected context revision.',
                });
            }
            if (ack.acknowledgedRevision !== currentSnapshot.revision) {
                await turnHandle.invalidate();
                throw new ContextDelegationError('CONTEXT_REVISION_MISMATCH', `Continuable child acknowledged revision "${ack.acknowledgedRevision}", but expected revision "${currentSnapshot.revision}".`, {
                    layer: 'context',
                    codexInvoked: true,
                    workspaceMayHaveChanged: true,
                    nextAction: 'Ensure child agent acknowledges matching context revision.',
                });
            }
        }
        else if (ack.valid) {
            if (ack.acknowledgedRevision !== currentSnapshot.revision) {
                await turnHandle.invalidate();
                throw new ContextDelegationError('CONTEXT_REVISION_MISMATCH', `Continuable child acknowledged revision "${ack.acknowledgedRevision}", but expected revision "${currentSnapshot.revision}".`, {
                    layer: 'context',
                    codexInvoked: true,
                    workspaceMayHaveChanged: true,
                    nextAction: 'Ensure child agent acknowledges matching context revision.',
                });
            }
        }
        turnHandle.commit(currentSnapshot);
        return {
            success: true,
            provider: providerName,
            workspaceRoot: prepared.context.workspaceRoot,
            contextFilesLoaded: prepared.context.files.map(file => file.relativePath),
            contextFilesMissing: [...prepared.context.missingFiles],
            contextFilesTruncated: [...prepared.context.truncatedFiles],
            contextChars: prepared.context.totalChars,
            runId: turnResult.childId,
            codexFinal: turnResult.finalText,
            parentVerificationRequired: true,
            ...(prepared.context.warning === undefined
                ? {}
                : { contextWarning: prepared.context.warning }),
            continuation: {
                reused: isReused,
                delegationKey: input.delegation_key,
                contextMode: selectedHandoff.contextMode,
                revision: currentSnapshot.revision,
                ...(selectedHandoff.payload.baseRevision ? { baseRevision: selectedHandoff.payload.baseRevision } : {}),
                ...(selectedHandoff.payload.refreshReason ? { refreshReason: selectedHandoff.payload.refreshReason } : {}),
                handoffBytes: selectedHandoff.handoffBytes,
            },
        };
    }
}
function cancelledBeforeInvocation() {
    return new ContextDelegationError('CODEX_CANCELLED', 'Delegation was cancelled before Codex was invoked.', {
        layer: 'delegation',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Retry only if the task is still required.',
    });
}
function providerNotFound(providerName, codexInvoked, cause) {
    return new ContextDelegationError('CODEX_PROVIDER_NOT_FOUND', `No subagent provider is registered as "${providerName}".`, {
        layer: 'provider',
        codexInvoked,
        workspaceMayHaveChanged: false,
        nextAction: `Load or repair the official "${providerName}" provider before retrying.`,
    }, cause === undefined ? undefined : { cause });
}
//# sourceMappingURL=service.js.map