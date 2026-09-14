import { ContextDelegationError } from "../errors.js";
export const MAX_FAILURE_PARTIAL_CHARS = 8_000;
export const MAX_PROVIDER_DIAGNOSTIC_BYTES = 4_096;
/** Flatten only user-visible text blocks; reasoning and tool payloads never cross this boundary. */
export function textFromContentBlocks(blocks) {
    return blocks
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
}
function clampUtf16WithoutSplittingSurrogate(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    const notice = '\n[... partial output truncated ...]';
    let end = Math.max(0, maxChars - notice.length);
    if (end > 0) {
        const finalCodeUnit = value.charCodeAt(end - 1);
        if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF)
            end -= 1;
    }
    return `${value.slice(0, end)}${notice}`;
}
/** Defensive enforcement of the provider seam's documented 4096-byte diagnostic limit. */
export function boundedProviderDiagnostic(value) {
    if (value === undefined)
        return undefined;
    if (Buffer.byteLength(value, 'utf8') <= MAX_PROVIDER_DIAGNOSTIC_BYTES)
        return value;
    let bytes = 0;
    let bounded = '';
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > MAX_PROVIDER_DIAGNOSTIC_BYTES)
            break;
        bounded += character;
        bytes += characterBytes;
    }
    return bounded;
}
export function describeAbnormalResult(result) {
    let headline;
    switch (result.stopReason) {
        case 'aborted':
            headline = 'Codex delegation was cancelled.';
            break;
        case 'error':
            headline = 'Codex delegation failed.';
            break;
        case 'max-tokens':
            headline = 'Codex reached its token limit before completing the task.';
            break;
        case 'refusal':
            headline = 'Codex declined the delegated task.';
            break;
        case 'completed':
            headline = 'Codex delegation completed.';
            break;
        default:
            headline = `Codex ended with an unsupported stop reason (${String(result.stopReason)}).`;
            break;
    }
    const diagnostic = boundedProviderDiagnostic(result.diagnostic);
    const partial = clampUtf16WithoutSplittingSurrogate(textFromContentBlocks(result.output), MAX_FAILURE_PARTIAL_CHARS);
    return [
        headline,
        ...(diagnostic === undefined ? [] : [`Provider diagnostic: ${diagnostic}`]),
        ...(partial.length === 0 ? [] : [`Partial Codex output:\n${partial}`]),
    ].join('\n');
}
/**
 * Settle result first, then unconditionally await disposal. The two outcomes
 * remain independent so teardown can neither hide execution failure nor turn
 * a failed cleanup into success/cancellation.
 */
export async function settlePublishedCodexRun(run) {
    const [execution] = await Promise.allSettled([run.result]);
    const [disposal] = await Promise.allSettled([
        Promise.resolve().then(() => run.dispose()),
    ]);
    return { execution, disposal };
}
function failureCause(executionFailed, executionReason, disposalFailed, disposalReason) {
    if (executionFailed && disposalFailed) {
        return new AggregateError([executionReason, disposalReason], 'Codex execution and run disposal both failed.');
    }
    return executionFailed ? executionReason : disposalReason;
}
export function classifyPublishedSettlement(settlement, signal) {
    const { execution, disposal } = settlement;
    const result = execution.status === 'fulfilled' ? execution.value : undefined;
    const abnormal = result !== undefined && result.stopReason !== 'completed';
    const executionReason = execution.status === 'rejected'
        ? execution.reason
        : abnormal
            ? new Error(describeAbnormalResult(result))
            : undefined;
    const executionFailed = execution.status === 'rejected' || abnormal;
    const disposalReason = disposal.status === 'rejected' ? disposal.reason : undefined;
    const disposalFailed = disposal.status === 'rejected';
    const cause = failureCause(executionFailed, executionReason, disposalFailed, disposalReason);
    if (disposalFailed) {
        const message = abnormal
            ? `${describeAbnormalResult(result)}\nAdditionally, the Codex run could not be disposed safely.`
            : executionFailed
                ? 'Codex execution and run disposal both failed.'
                : 'Codex completed, but its run could not be disposed safely.';
        throw new ContextDelegationError('CODEX_DELEGATION_FAILED', message, {
            layer: 'delegation',
            codexInvoked: true,
            workspaceMayHaveChanged: true,
            nextAction: 'Treat the workspace as potentially changed and inspect provider health before retrying.',
        }, { cause });
    }
    if (execution.status === 'rejected') {
        if (signal.aborted && !(execution.reason instanceof AggregateError)) {
            throw new ContextDelegationError('CODEX_CANCELLED', 'Codex delegation was cancelled while awaiting its result.', {
                layer: 'delegation',
                codexInvoked: true,
                workspaceMayHaveChanged: true,
                nextAction: 'Inspect the workspace before retrying because Codex may have made partial changes.',
            }, { cause });
        }
        throw new ContextDelegationError('CODEX_DELEGATION_FAILED', 'Codex run failed with an unrepresentable infrastructure error.', {
            layer: 'delegation',
            codexInvoked: true,
            workspaceMayHaveChanged: true,
            nextAction: 'Inspect the workspace and provider logs, then retry only if safe.',
        }, { cause });
    }
    if (abnormal) {
        const code = result.stopReason === 'aborted' ? 'CODEX_CANCELLED' : 'CODEX_DELEGATION_FAILED';
        throw new ContextDelegationError(code, describeAbnormalResult(result), {
            layer: 'delegation',
            codexInvoked: true,
            workspaceMayHaveChanged: true,
            nextAction: result.stopReason === 'aborted'
                ? 'Inspect partial workspace changes before deciding whether to retry.'
                : 'Inspect the reported partial output and workspace state before retrying.',
        }, { cause });
    }
    return execution.value;
}
//# sourceMappingURL=lifecycle.js.map