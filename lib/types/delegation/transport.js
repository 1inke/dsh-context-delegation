import { ContextDelegationError } from "../errors.js";
function textFromBlocks(blocks = []) {
    return blocks
        .filter((b) => b.type === 'text')
        .map(b => b.text)
        .join('');
}
export class ContinuationTransportAdapter {
    ctx;
    quiescenceTimeoutMs;
    settledRunIds = new Set();
    constructor(ctx, options) {
        this.ctx = ctx;
        this.quiescenceTimeoutMs = options?.quiescenceTimeoutMs ?? 5000;
    }
    /**
     * Start a new continuable child and return immediately after inbox acceptance with an awaitSettlement function.
     */
    async startChild(options) {
        const { provider, label, promptText, parent, signal } = options;
        if (signal.aborted) {
            throw new ContextDelegationError('CODEX_CANCELLED', 'Delegation was cancelled before continuable child start.', {
                layer: 'delegation',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Retry only if the task is still required.',
            });
        }
        const providerObj = this.ctx.subagents.getProvider(provider);
        if (!providerObj) {
            throw new ContextDelegationError('CODEX_PROVIDER_NOT_FOUND', `No subagent provider is registered as "${provider}".`, {
                layer: 'provider',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: `Load or repair the provider "${provider}" before retrying.`,
            });
        }
        if (typeof providerObj.prepareContinuable !== 'function') {
            throw new ContextDelegationError('UNSUPPORTED_CONTINUATION_PROVIDER', `Provider "${provider}" does not support continuable children (lacks prepareContinuable capability).`, {
                layer: 'provider',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Use fresh mode or select a continuable-capable provider (e.g. spawn).',
            });
        }
        let earlyEndInfo;
        let targetChildId;
        let expectedMessageId;
        let activeRunId;
        const startRuns = new Map();
        const disposeStart = this.ctx.on('subagent/start', (info) => {
            if (info?.id) {
                const id = String(info.id);
                const runId = info.runId ? String(info.runId) : undefined;
                if (runId) {
                    startRuns.set(id, runId);
                }
                if (targetChildId !== undefined && id === targetChildId) {
                    activeRunId = runId;
                }
            }
        });
        const earlyEnds = new Map();
        const preDisposeEnd = this.ctx.on('subagent/end', (info) => {
            if (info?.id) {
                earlyEnds.set(String(info.id), info);
            }
        });
        let started;
        try {
            started = await this.ctx.subagents.startContinuable({
                provider,
                label,
                request: {
                    prompt: [{ type: 'text', text: promptText }],
                    parent,
                },
                signal,
            });
        }
        catch (error) {
            disposeStart();
            preDisposeEnd();
            if (signal.aborted) {
                throw new ContextDelegationError('CODEX_CANCELLED', 'Continuable child startup was cancelled before inbox acceptance.', {
                    layer: 'delegation',
                    codexInvoked: false,
                    workspaceMayHaveChanged: false,
                    nextAction: 'Retry only if the task is still required.',
                }, { cause: error });
            }
            throw new ContextDelegationError('CODEX_DELEGATION_FAILED', `Failed to start continuable child on provider "${provider}".`, {
                layer: 'delegation',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Inspect provider state and logs.',
            }, { cause: error });
        }
        const childId = String(started.childId);
        targetChildId = childId;
        expectedMessageId = started.messageId ? String(started.messageId) : undefined;
        if (activeRunId === undefined && startRuns.has(childId)) {
            activeRunId = startRuns.get(childId);
        }
        const candidateEnd = earlyEnds.get(childId);
        if (candidateEnd) {
            const isSettled = candidateEnd.runId && this.settledRunIds.has(String(candidateEnd.runId));
            const isRunMismatch = candidateEnd.runId !== undefined && (activeRunId === undefined || String(candidateEnd.runId) !== activeRunId);
            const candidateMsgId = candidateEnd.messageId;
            const isMsgMismatch = expectedMessageId !== undefined && candidateMsgId !== undefined && String(candidateMsgId) !== expectedMessageId;
            if (!isSettled && !isRunMismatch && !isMsgMismatch) {
                earlyEndInfo = candidateEnd;
            }
        }
        const awaitSettlement = () => {
            disposeStart();
            preDisposeEnd();
            return this.awaitChildTurnSettlement({
                childId,
                parent,
                signal,
                expectedMessageId,
                activeRunId,
                initialEndInfo: earlyEndInfo,
            });
        };
        return { childId, awaitSettlement };
    }
    /**
     * Start a new continuable child and await correlated settlement of its initial turn.
     */
    async startChildAndTurn(options) {
        const { awaitSettlement } = await this.startChild(options);
        return awaitSettlement();
    }
    /**
     * Send a follow-up turn prompt and return an awaitSettlement function.
     */
    async sendFollowup(options) {
        const { parent, childId, promptText, signal } = options;
        if (signal.aborted) {
            throw new ContextDelegationError('CODEX_CANCELLED', 'Follow-up delegation was cancelled before message acceptance.', {
                layer: 'delegation',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Retry only if required.',
            });
        }
        let earlyEndInfo;
        let expectedMessageId;
        let activeRunId;
        const disposeStart = this.ctx.on('subagent/start', (info) => {
            if (String(info.id) === String(childId)) {
                activeRunId = info.runId ? String(info.runId) : undefined;
            }
        });
        // Pre-attach listener before sending message to buffer any early end events
        const preDisposeEnd = this.ctx.on('subagent/end', (info) => {
            if (String(info.id) !== String(childId))
                return;
            if (info.runId && this.settledRunIds.has(String(info.runId)))
                return;
            if (info.runId !== undefined && (activeRunId === undefined || String(info.runId) !== activeRunId))
                return;
            const infoMsgId = info.messageId;
            if (expectedMessageId !== undefined && infoMsgId !== undefined && String(infoMsgId) !== expectedMessageId)
                return;
            earlyEndInfo = info;
        });
        let messageIdResult;
        try {
            messageIdResult = await this.ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text: promptText }], { signal });
        }
        catch (error) {
            disposeStart();
            preDisposeEnd();
            if (signal.aborted) {
                throw new ContextDelegationError('CODEX_CANCELLED', 'Follow-up message delivery was cancelled before inbox acceptance.', {
                    layer: 'delegation',
                    codexInvoked: false,
                    workspaceMayHaveChanged: false,
                    nextAction: 'Retry only if required.',
                }, { cause: error });
            }
            throw new ContextDelegationError('CODEX_DELEGATION_FAILED', `Failed to deliver follow-up message to continuable child "${childId}".`, {
                layer: 'delegation',
                codexInvoked: false,
                workspaceMayHaveChanged: false,
                nextAction: 'Inspect child session status.',
            }, { cause: error });
        }
        expectedMessageId = messageIdResult ? String(messageIdResult) : undefined;
        return () => {
            disposeStart();
            preDisposeEnd();
            return this.awaitChildTurnSettlement({
                childId,
                parent,
                signal,
                expectedMessageId,
                activeRunId,
                initialEndInfo: earlyEndInfo,
            });
        };
    }
    /**
     * Send a follow-up turn prompt to an existing continuable child and await correlated settlement.
     */
    async sendFollowupTurn(options) {
        const awaitSettlement = await this.sendFollowup(options);
        return awaitSettlement();
    }
    /**
     * Correlate child turn settlement via subagent/end event with cancel/interrupt handling.
     */
    awaitChildTurnSettlement(options) {
        const { childId, parent, signal, expectedMessageId, initialEndInfo, activeRunId: initialActiveRunId } = options;
        let currentActiveRunId = initialActiveRunId;
        const formatResult = (info) => {
            const stopReason = info.stopReason;
            const finalText = textFromBlocks(info.lastAssistantMessage ?? []);
            if (signal.aborted || stopReason === 'aborted') {
                throw new ContextDelegationError('CODEX_CANCELLED', 'Continuable delegation turn was cancelled during execution.', {
                    layer: 'delegation',
                    codexInvoked: true,
                    workspaceMayHaveChanged: true,
                    nextAction: 'Inspect workspace before deciding whether to retry.',
                });
            }
            if (stopReason !== 'completed') {
                throw new ContextDelegationError('CODEX_DELEGATION_FAILED', `Continuable delegation turn ended with abnormal stopReason: ${stopReason}.`, {
                    layer: 'delegation',
                    codexInvoked: true,
                    workspaceMayHaveChanged: true,
                    nextAction: 'Inspect child logs and workspace state.',
                });
            }
            return {
                childId: String(childId),
                stopReason,
                finalText,
                rawOutput: info.lastAssistantMessage ?? [],
            };
        };
        if (initialEndInfo) {
            if (initialEndInfo.runId) {
                this.settledRunIds.add(String(initialEndInfo.runId));
            }
            return Promise.resolve().then(() => formatResult(initialEndInfo));
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let disposeListener;
            let disposeStartListener;
            let quiescenceTimer;
            const cleanup = () => {
                settled = true;
                if (quiescenceTimer) {
                    clearTimeout(quiescenceTimer);
                    quiescenceTimer = undefined;
                }
                if (disposeListener) {
                    disposeListener();
                    disposeListener = undefined;
                }
                if (disposeStartListener) {
                    disposeStartListener();
                    disposeStartListener = undefined;
                }
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                if (settled)
                    return;
                try {
                    this.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent });
                }
                catch {
                    // Interrupt call may fail if child already gone
                }
                // Bounded quiescence timer: if end event never arrives, force drain and reject
                quiescenceTimer = setTimeout(async () => {
                    if (settled)
                        return;
                    try {
                        await this.drainChild(parent, childId);
                    }
                    catch {
                        // ignore drain error during force-quiescence
                    }
                    cleanup();
                    reject(new ContextDelegationError('CODEX_CANCELLED', 'Continuable delegation turn was cancelled and forced to quiescence after timeout.', {
                        layer: 'delegation',
                        codexInvoked: true,
                        workspaceMayHaveChanged: true,
                        nextAction: 'Inspect workspace before deciding whether to retry.',
                    }));
                }, this.quiescenceTimeoutMs);
            };
            disposeStartListener = this.ctx.on('subagent/start', (info) => {
                if (info && String(info.id) === String(childId)) {
                    currentActiveRunId = info.runId ? String(info.runId) : undefined;
                }
            });
            disposeListener = this.ctx.on('subagent/end', (info) => {
                if (String(info.id) !== String(childId))
                    return;
                if (info.runId && this.settledRunIds.has(String(info.runId))) {
                    // Ignore completion belonging to a previously settled run
                    return;
                }
                if (info.runId !== undefined && (currentActiveRunId === undefined || String(info.runId) !== currentActiveRunId)) {
                    // Ignore completion belonging to an unannounced or mismatched run
                    return;
                }
                const infoMsgId = info.messageId;
                if (expectedMessageId !== undefined && infoMsgId !== undefined && String(infoMsgId) !== expectedMessageId) {
                    // Ignore completion belonging to a different/older message
                    return;
                }
                cleanup();
                if (info.runId) {
                    this.settledRunIds.add(String(info.runId));
                }
                try {
                    resolve(formatResult(info));
                }
                catch (err) {
                    reject(err);
                }
            });
            if (signal.aborted) {
                onAbort();
            }
            else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }
    async drainChild(parent, childId) {
        await this.ctx.subagents.drainContinuableChildren(parent, [childId]);
    }
}
//# sourceMappingURL=transport.js.map