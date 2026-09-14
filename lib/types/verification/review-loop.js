import { applyContextPatches, buildContextPatches, computeContextFingerprint } from "../context/writeback.js";
import { ContextDelegationError } from "../errors.js";
import { parseExecutorReport } from "./executor-report.js";
import { buildReviewerPrompt, parseReviewReport } from "./reviewer.js";
import { collectWorkspaceEvidence } from "./workspace-evidence.js";
import { runVerificationCommands } from "./verification-runner.js";
/**
 * The bounded reviewed delegation loop:
 *   executor (fresh) -> independent evidence -> verification -> reviewer
 *   -> pass ends / rework retries within maxReviewRounds / blocked stops.
 *
 * The reviewer is always a FRESH one-shot child on its own provider name and
 * never sees the executor's session. BLOCKED outcomes are propagated as
 * `outcome: 'blocked'` and are never wrapped into plain success by callers.
 */
/** True when the caller explicitly asked for the reviewed flow. */
export function hasReviewRequest(input) {
    return Array.isArray(input.acceptance_criteria) && input.acceptance_criteria.length > 0;
}
function buildReworkInput(original, lastReport, lastReview) {
    const reworkNotes = [
        'REWORK ROUND: your previous attempt was reviewed and did not pass. Fix the gaps below. The workspace already contains the changes of the previous attempt; evidence is re-collected against the current state.',
        '',
        `Previous executor report status: ${lastReport.status}`,
        `Previous summary: ${lastReport.summary}`,
        `Reviewer verdict: ${lastReview.verdict}`,
        ...(lastReview.reasons.length > 0 ? ['', 'Reviewer reasons:', ...lastReview.reasons.map(reason => `- ${reason}`)] : []),
        ...(lastReview.unmetCriteria.length > 0 ? ['', 'Unmet acceptance criteria:', ...lastReview.unmetCriteria.map(criterion => `- ${criterion}`)] : []),
        ...(lastReview.suspiciousClaims.length > 0 ? ['', 'Claims the reviewer found unsupported:', ...lastReview.suspiciousClaims.map(claim => `- ${claim}`)] : []),
        ...(lastReview.recommendedNextAction === undefined ? [] : ['', `Reviewer recommended next action: ${lastReview.recommendedNextAction}`]),
    ].join('\n');
    return {
        ...original,
        notes: original.notes === undefined ? reworkNotes : `${reworkNotes}\n\n---\n\nOriginal caller notes:\n${original.notes}`,
    };
}
export async function runReviewedDelegation(deps, input, execution) {
    const { config } = deps;
    const criteria = input.acceptance_criteria ?? [];
    if (criteria.length === 0) {
        throw new Error('runReviewedDelegation requires non-empty acceptance_criteria');
    }
    const maxAttempts = 1 + config.maxReviewRounds;
    const reviews = [];
    const verificationCommands = input.verification_commands ?? [];
    let attempt = 0;
    let lastResult;
    let lastReport;
    let lastReview;
    let evidence = { available: false, reason: 'not collected', filesChanged: [] };
    let verification = [];
    let reworkLimitReached = false;
    while (attempt < maxAttempts) {
        attempt += 1;
        const attemptInput = attempt === 1
            ? input
            : buildReworkInput(input, lastReport, lastReview);
        try {
            lastResult = await deps.runFreshAttempt(attemptInput, execution);
        }
        catch (error) {
            if (error instanceof ContextDelegationError && error.code === 'CODEX_DELEGATION_FAILED') {
                const blockedResult = lastResult ?? unavailableResult(deps.config, error);
                await finishLoopTrace(deps, deps.trace, blockedResult, 'blocked', `CODEX_DELEGATION_FAILED: ${error.message}`);
                return finalize(blockedResult, 'blocked', attempt, attempt, {
                    status: 'failed',
                    summary: 'executor infrastructure failure',
                    filesChanged: [],
                    verification: [],
                    risks: [],
                    trustNotes: [error.message],
                }, evidence, verification, reviews, false);
            }
            throw error;
        }
        lastReport = parseExecutorReport(lastResult.codexFinal);
        // Executor-reported infrastructure/authority failure: stop without
        // spending a reviewer round — a reviewer cannot fix a blocked attempt.
        if (lastReport.status === 'blocked') {
            await finishLoopTrace(deps, deps.trace, lastResult, 'blocked');
            return finalize(lastResult, 'blocked', attempt, attempt, lastReport, evidence, verification, reviews, false);
        }
        evidence = await collectWorkspaceEvidence({ workspaceRoot: lastResult.workspaceRoot, signal: execution.signal });
        deps.trace?.record('evidence', { available: evidence.available, changedFileCount: evidence.filesChanged.length });
        verification = await runVerificationCommands(verificationCommands, {
            workspaceRoot: lastResult.workspaceRoot,
            signal: execution.signal,
            timeoutMs: config.verificationTimeoutMs,
            maxOutputChars: config.verificationMaxOutputChars,
        });
        const prompt = buildReviewerPrompt({
            task: input.task,
            acceptanceCriteria: criteria,
            attempt,
            maxAttempts,
            context: {
                files: lastResult.contextFilesLoaded.map(relativePath => ({ relativePath, includedChars: 0 })),
                totalChars: lastResult.contextChars,
                missingFiles: lastResult.contextFilesMissing,
            },
            executorReport: lastReport,
            workspaceEvidence: evidence,
            verificationEvidence: verification,
        });
        deps.trace?.record('verification', {
            commands: verificationCommands.length,
            passed: verification.filter(entry => entry.outcome === 'passed').length,
            failed: verification.filter(entry => entry.outcome === 'failed').length,
            notRun: verification.filter(entry => entry.outcome === 'not-run').length,
        });
        let reviewRun;
        try {
            reviewRun = await deps.startReviewer(prompt, execution);
        }
        catch (error) {
            if (error instanceof ContextDelegationError && error.code === 'CODEX_DELEGATION_FAILED') {
                lastReview = {
                    verdict: 'blocked',
                    reasons: [`reviewer infrastructure failure: ${error.message}`],
                    unmetCriteria: [],
                    suspiciousClaims: [],
                    trustNotes: ['reviewer could not run; outcome blocked rather than an unchecked pass'],
                };
                reviews.push(lastReview);
                await finishLoopTrace(deps, deps.trace, lastResult, 'blocked');
                return finalize(lastResult, 'blocked', attempt, attempt, lastReport, evidence, verification, reviews, false);
            }
            throw error;
        }
        lastReview = parseReviewReport(reviewRun.finalText);
        deps.trace?.record('review', { attempt, verdict: lastReview.verdict });
        reviews.push(lastReview);
        if (lastReview.verdict === 'pass') {
            const withWriteback = await attachWriteback(deps.config, lastResult, lastReport);
            if (withWriteback.outcome !== undefined) {
                deps.trace?.record('write-back', {
                    mode: withWriteback.outcome.mode,
                    status: withWriteback.outcome.status,
                    patches: withWriteback.outcome.patches.length,
                });
            }
            await finishLoopTrace(deps, deps.trace, withWriteback.result, 'completed', withWriteback.outcome?.fingerprintAfter);
            return finalize(withWriteback.result, 'completed', attempt, attempt, lastReport, evidence, verification, reviews, false, withWriteback.outcome);
        }
        if (lastReview.verdict === 'blocked') {
            await finishLoopTrace(deps, deps.trace, lastResult, 'blocked');
            return finalize(lastResult, 'blocked', attempt, attempt, lastReport, evidence, verification, reviews, false);
        }
        if (attempt >= maxAttempts) {
            reworkLimitReached = true;
            break;
        }
        deps.trace?.record('rework', { attempt });
    }
    await finishLoopTrace(deps, deps.trace, lastResult, 'rework');
    return finalize(lastResult, 'rework', attempt, attempt, lastReport, evidence, verification, reviews, reworkLimitReached);
}
/** Finish the trace with metadata only: a revision fingerprint, never payloads. */
export async function finishLoopTrace(deps, trace, result, outcome, revision) {
    if (trace === undefined)
        return;
    let resolved = revision;
    if (resolved === undefined && result !== undefined && result.workspaceRoot !== '') {
        try {
            resolved = await computeContextFingerprint(result.workspaceRoot, deps.config.contextRoot);
        }
        catch { /* fingerprint is best-effort metadata */ }
    }
    trace.setSelectedContextChars(result?.contextChars ?? 0);
    trace.finish(outcome, {
        ...(resolved === undefined ? {} : { contextRevision: resolved }),
        contextMode: 'single',
    });
}
/**
 * Reviewer-pass gate (roadmap 6.2): proposals become patches only here.
 * 'proposal' mode never touches files; 'apply' verifies before and after.
 */
async function attachWriteback(config, result, lastReport) {
    const mode = config.contextWriteback;
    const proposal = lastReport.contextUpdate;
    if (mode === 'disabled' || proposal === undefined) {
        if (mode === 'disabled' && proposal !== undefined) {
            return {
                result,
                outcome: {
                    mode: 'disabled', status: 'dropped', patches: [],
                    reason: 'contextWriteback is disabled; the executor proposal was dropped',
                },
            };
        }
        return { result };
    }
    const built = buildContextPatches(proposal);
    if (built.patches.length === 0) {
        return {
            result,
            outcome: {
                mode, status: 'dropped', patches: [],
                ...(built.trustNotes.length > 0 ? { reason: built.trustNotes.join('; ') } : {}),
            },
        };
    }
    if (mode === 'proposal') {
        return { result, outcome: { mode, status: 'proposed', patches: built.patches, ...(built.trustNotes.length > 0 ? { reason: built.trustNotes.join('; ') } : {}) } };
    }
    try {
        const applied = await applyContextPatches({
            workspaceRoot: result.workspaceRoot,
            contextRoot: config.contextRoot,
            patches: built.patches,
            maxSnapshotBytes: config.maxSnapshotBytes,
        });
        return {
            result,
            outcome: {
                mode, status: 'applied', patches: built.patches,
                fingerprintBefore: applied.fingerprintBefore, fingerprintAfter: applied.fingerprintAfter,
                ...(built.trustNotes.length > 0 ? { reason: built.trustNotes.join('; ') } : {}),
            },
        };
    }
    catch (error) {
        return {
            result,
            outcome: {
                mode, status: 'failed', patches: built.patches,
                reason: error instanceof Error ? error.message : String(error),
            },
        };
    }
}
/** Minimal result shell for a blocked outcome when no executor result exists. */
function unavailableResult(config, error) {
    return {
        success: true,
        provider: config.executorRouting.implementation.provider,
        workspaceRoot: '',
        contextFilesLoaded: [],
        contextFilesMissing: [],
        contextFilesTruncated: [],
        contextChars: 0,
        runId: 'unavailable',
        codexFinal: error.message,
        parentVerificationRequired: true,
    };
}
function finalize(lastResult, outcome, rounds, executorAttempts, finalExecutorReport, workspaceEvidence, verification, reviews, reworkLimitReached, writeback) {
    const review = {
        outcome,
        rounds,
        executorAttempts,
        finalExecutorReport,
        workspaceEvidence,
        verification,
        reviews,
        ...(reworkLimitReached ? { reworkLimitReached: true } : {}),
    };
    return {
        ...lastResult,
        review,
        ...(writeback === undefined ? {} : { contextWriteback: writeback }),
    };
}
//# sourceMappingURL=review-loop.js.map