export const CODEX_EXPERT_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        success: { type: 'boolean', const: true, required: true },
        provider: { type: 'string', required: true },
        workspaceRoot: { type: 'string', required: true },
        contextFilesLoaded: { type: 'array', items: { type: 'string' }, required: true },
        contextFilesMissing: { type: 'array', items: { type: 'string' }, required: true },
        contextFilesTruncated: { type: 'array', items: { type: 'string' }, required: true },
        contextChars: { type: 'number', required: true },
        runId: { type: 'string', required: true },
        codexFinal: { type: 'string', required: true },
        parentVerificationRequired: { type: 'boolean', const: true, required: true },
        contextWarning: { type: 'string' },
        diagnostic: { type: 'string' },
        continuation: {
            type: 'object',
            additionalProperties: false,
            properties: {
                reused: { type: 'boolean', required: true },
                delegationKey: { type: 'string', required: true },
                contextMode: { type: 'string', enum: ['full', 'delta', 'full-refresh'], required: true },
                revision: { type: 'string', required: true },
                baseRevision: { type: 'string' },
                refreshReason: { type: 'string' },
                handoffBytes: { type: 'number', required: true },
            },
        },
        review: {
            type: 'object',
            additionalProperties: false,
            properties: {
                outcome: { type: 'string', enum: ['completed', 'rework', 'blocked'], required: true },
                rounds: { type: 'number', required: true },
                executorAttempts: { type: 'number', required: true },
                finalExecutorReport: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        status: { type: 'string', enum: ['completed', 'blocked', 'failed'], required: true },
                        summary: { type: 'string', required: true },
                        filesChanged: { type: 'array', items: { type: 'string' }, required: true },
                        verification: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    command: { type: 'string', required: true },
                                    outcome: { type: 'string', enum: ['passed', 'failed', 'not-run'], required: true },
                                    evidence: { type: 'string' },
                                },
                            },
                            required: true,
                        },
                        risks: { type: 'array', items: { type: 'string' }, required: true },
                        trustNotes: { type: 'array', items: { type: 'string' } },
                    },
                    required: true,
                },
                workspaceEvidence: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        available: { type: 'boolean', required: true },
                        reason: { type: 'string' },
                        filesChanged: { type: 'array', items: { type: 'string' }, required: true },
                        diffSummary: { type: 'string' },
                    },
                    required: true,
                },
                verification: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            command: { type: 'string', required: true },
                            outcome: { type: 'string', enum: ['passed', 'failed', 'not-run'], required: true },
                            exitCode: { type: 'number' },
                            timedOut: { type: 'boolean', required: true },
                            evidence: { type: 'string', required: true },
                        },
                    },
                    required: true,
                },
                reviews: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            verdict: { type: 'string', enum: ['pass', 'rework', 'blocked'], required: true },
                            reasons: { type: 'array', items: { type: 'string' }, required: true },
                            unmetCriteria: { type: 'array', items: { type: 'string' }, required: true },
                            suspiciousClaims: { type: 'array', items: { type: 'string' }, required: true },
                            recommendedNextAction: { type: 'string' },
                            trustNotes: { type: 'array', items: { type: 'string' } },
                        },
                    },
                    required: true,
                },
                reworkLimitReached: { type: 'boolean' },
            },
        },
    },
};
function reviewStatusLine(value) {
    const review = value.review;
    if (review === undefined)
        return `Status: success (provider: ${value.provider}, run: ${value.runId})`;
    const suffix = `provider: ${value.provider}, run: ${value.runId}, executor attempts: ${review.executorAttempts}, review rounds: ${review.rounds}`;
    if (review.outcome === 'blocked')
        return `Status: BLOCKED (${suffix})`;
    if (review.outcome === 'rework')
        return `Status: REWORK (${suffix})`;
    return `Status: success (provider: ${value.provider}, run: ${value.runId})`;
}
/** Concise model-facing rendering of a canonical successful delegation. */
export function renderCodexExpertResult(value) {
    const loaded = value.contextFilesLoaded.length === 0 ? '(none)' : value.contextFilesLoaded.join(', ');
    const missing = value.contextFilesMissing.length === 0 ? '(none)' : value.contextFilesMissing.join(', ');
    const truncated = value.contextFilesTruncated.length === 0 ? '(none)' : value.contextFilesTruncated.join(', ');
    const continuationSection = value.continuation === undefined
        ? []
        : [
            '',
            '## Continuation',
            `Key: ${value.continuation.delegationKey} (${value.continuation.reused ? 'reused' : 'initial'}, mode: ${value.continuation.contextMode})`,
            `Revision: ${value.continuation.revision}`,
            `Payload: ${value.continuation.handoffBytes} bytes${value.continuation.refreshReason ? ` (${value.continuation.refreshReason})` : ''}`,
        ];
    const writeback = value.contextWriteback;
    const writebackSection = writeback === undefined
        ? []
        : [
            '',
            `## Context Write-Back (${writeback.mode}: ${writeback.status})`,
            ...(writeback.patches.length > 0
                ? ['Proposed patches:', ...writeback.patches.map(patch => `- [${patch.target}] ${patch.operation} ${patch.headingPath.length > 0 ? patch.headingPath.join(' > ') : '(end of file)'} — ${patch.reason}`)]
                : ['No patches.']),
            ...(writeback.fingerprintAfter !== undefined
                ? [`Fingerprint: ${writeback.fingerprintBefore} → ${writeback.fingerprintAfter}`]
                : []),
            ...(writeback.reason === undefined ? [] : [`Note: ${writeback.reason}`]),
            ...(writeback.status === 'proposed' ? ['These are PROPOSALS only; no context file was modified by the plugin.'] : []),
        ];
    const review = value.review;
    const reviewSection = review === undefined
        ? []
        : [
            '',
            `## Review (${review.outcome})`,
            `Executor report status: ${review.finalExecutorReport.status}`,
            `Executor claims filesChanged: ${review.finalExecutorReport.filesChanged.length === 0 ? '(none)' : review.finalExecutorReport.filesChanged.join(', ')}`,
            `Independently observed changed files: ${review.workspaceEvidence.available ? (review.workspaceEvidence.filesChanged.length === 0 ? '(none)' : review.workspaceEvidence.filesChanged.join(', ')) : `unavailable (${review.workspaceEvidence.reason ?? 'unknown'})`}`,
            ...((review.verification.length > 0)
                ? ['Independent verification:', ...review.verification.map(entry => `- [${entry.outcome}] ${entry.command}${entry.timedOut ? ' (timed out)' : ''}${entry.evidence ? ` — ${(entry.evidence.split('\n')[0] ?? '').slice(0, 200)}` : ''}`)]
                : []),
            ...review.reviews.flatMap((entry, index) => [
                `Reviewer verdict (round ${index + 1}): ${entry.verdict}`,
                ...(entry.reasons.length > 0 ? [`  Reasons: ${entry.reasons.join('; ')}`] : []),
                ...(entry.unmetCriteria.length > 0 ? [`  Unmet criteria: ${entry.unmetCriteria.join('; ')}`] : []),
                ...(entry.suspiciousClaims.length > 0 ? [`  Suspicious claims: ${entry.suspiciousClaims.join('; ')}`] : []),
            ]),
            ...(review.outcome === 'blocked'
                ? [
                    '',
                    'CRITICAL REVIEW OUTCOME: BLOCKED.',
                    'This delegation ended BLOCKED. Do NOT treat it as a successful completion. The parent agent MUST NOT declare [STATUS: VERIFIED]; inspect the reported reasons before doing anything else.',
                ]
                : []),
            ...(review.outcome === 'rework'
                ? [
                    '',
                    'CRITICAL REVIEW OUTCOME: REWORK REQUIRED.',
                    `The rework limit (${review.reviews.length - 1} automatic rework(s)) was reached without a pass from the independent reviewer.`,
                    'The parent agent MUST NOT output [STATUS: VERIFIED]. If manual verification was conducted, report it strictly as conditional manual acceptance and do NOT override the independent reviewer verdict.',
                ]
                : []),
        ];
    return [
        '# Codex Expert Result',
        '',
        reviewStatusLine(value),
        ...continuationSection,
        '',
        '## Context Loaded',
        `${loaded} (${value.contextChars} characters)`,
        '',
        '## Missing',
        missing,
        '',
        '## Truncated',
        truncated,
        ...(value.contextWarning === undefined ? [] : ['', '## Context Warning', value.contextWarning]),
        ...(value.diagnostic === undefined ? [] : ['', '## Provider Diagnostic', value.diagnostic]),
        ...reviewSection,
        ...writebackSection,
        '',
        '## Codex Final Result',
        value.codexFinal,
        '',
        '## Parent Verification Required',
        review !== undefined && (review.outcome === 'rework' || review.outcome === 'blocked')
            ? `CRITICAL: The independent reviewer outcome is ${review.outcome.toUpperCase()}. Do NOT output [STATUS: VERIFIED]. The parent agent must honestly report the review failure/rework state.`
            : 'The parent agent must independently verify file changes, tests, and reported metrics.',
    ].join('\n');
}
//# sourceMappingURL=result.js.map