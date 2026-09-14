import type { ContextDecisionProposal, ContextExperimentProposal, ContextUpdateProposal, ExecutorReport, VerificationClaim } from '../types.ts'

/**
 * Fence label the handoff instructs the executor to use for its structured
 * self-report. The report is a CLAIM surface for the reviewer, never
 * acceptance evidence.
 */
export const EXECUTOR_REPORT_FENCE = 'dsh-executor-report'

const EXECUTOR_STATUSES = ['completed', 'blocked', 'failed'] as const
const CLAIM_OUTCOMES = ['passed', 'failed', 'not-run'] as const

const MAX_SUMMARY_CHARS = 4000
const MAX_ITEM_CHARS = 2000
const MAX_ITEMS = 200

function asString(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.slice(0, maxChars) : ''
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, MAX_ITEMS)
    .map(entry => entry.slice(0, MAX_ITEM_CHARS))
}

function coerceContextUpdate(value: unknown): ContextUpdateProposal | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.slice(0, 8).map((entry): ContextDecisionProposal => {
      const item = (entry ?? {}) as Record<string, unknown>
      return { decision: asString(item.decision, MAX_ITEM_CHARS), ...(typeof item.rationale === 'string' ? { rationale: item.rationale.slice(0, MAX_ITEM_CHARS) } : {}) }
    }).filter(entry => entry.decision.length > 0)
    : []
  const experiments = Array.isArray(raw.experiments)
    ? raw.experiments.slice(0, 8).map((entry): ContextExperimentProposal => {
      const item = (entry ?? {}) as Record<string, unknown>
      return {
        experiment: asString(item.experiment, MAX_ITEM_CHARS),
        ...(typeof item.command === 'string' && item.command.length > 0 ? { command: item.command.slice(0, MAX_ITEM_CHARS) } : {}),
        ...(typeof item.result === 'string' && item.result.length > 0 ? { result: item.result.slice(0, MAX_ITEM_CHARS) } : {}),
        ...(typeof item.conclusion === 'string' && item.conclusion.length > 0 ? { conclusion: item.conclusion.slice(0, MAX_ITEM_CHARS) } : {}),
      }
    }).filter(entry => entry.experiment.length > 0)
    : []
  const proposal: ContextUpdateProposal = {
    ...(Array.isArray(raw.currentState) ? { currentState: asStringArray(raw.currentState) } : {}),
    ...(Array.isArray(raw.projectContext) ? { projectContext: asStringArray(raw.projectContext) } : {}),
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(experiments.length > 0 ? { experiments } : {}),
  }
  const hasAny = proposal.currentState !== undefined || proposal.projectContext !== undefined
    || proposal.decisions !== undefined || proposal.experiments !== undefined
  return hasAny ? proposal : undefined
}

function coerceClaim(value: unknown): VerificationClaim {
  const raw = (value ?? {}) as Record<string, unknown>
  const outcome = typeof raw.outcome === 'string' && (CLAIM_OUTCOMES as readonly string[]).includes(raw.outcome)
    ? raw.outcome as VerificationClaim['outcome']
    : 'not-run'
  return {
    command: asString(raw.command, MAX_ITEM_CHARS),
    outcome,
    ...(typeof raw.evidence === 'string' && raw.evidence.length > 0
      ? { evidence: raw.evidence.slice(0, MAX_ITEM_CHARS) }
      : {}),
  }
}

/**
 * Extract the LAST `dsh-executor-report` fence from the executor's final
 * message and coerce it conservatively. A missing, malformed, or lying
 * report degrades to `status: 'failed'` with a trust note — it can never be
 * upgraded into success. The full text remains available to the caller
 * separately, so nothing is lost by coercion.
 */
export function parseExecutorReport(finalText: string): ExecutorReport {
  const fenceLabel = `\`\`\`json ${EXECUTOR_REPORT_FENCE}`
  const begin = finalText.lastIndexOf(fenceLabel)
  if (begin >= 0) {
    const jsonStart = finalText.indexOf('\n', begin)
    const end = finalText.indexOf('```', begin + fenceLabel.length)
    if (jsonStart >= 0 && end > jsonStart) {
      const jsonText = finalText.slice(jsonStart + 1, end).trim()
      try {
        const raw = JSON.parse(jsonText) as Record<string, unknown>
        const status = typeof raw.status === 'string' && (EXECUTOR_STATUSES as readonly string[]).includes(raw.status)
          ? raw.status as ExecutorReport['status']
          : undefined
        const rawVerification = Array.isArray(raw.verification) ? raw.verification.slice(0, MAX_ITEMS) : []
        const contextUpdate = coerceContextUpdate(raw.contextUpdate)
        if (status === undefined) {
          return {
            status: 'failed',
            summary: asString(raw.summary, MAX_SUMMARY_CHARS),
            filesChanged: asStringArray(raw.filesChanged),
            verification: rawVerification.map(coerceClaim),
            risks: asStringArray(raw.risks),
            ...(contextUpdate === undefined ? {} : { contextUpdate }),
            trustNotes: [`executor report carried unknown status ${JSON.stringify(raw.status)}; coerced to failed`],
          }
        }
        return {
          status,
          summary: asString(raw.summary, MAX_SUMMARY_CHARS),
          filesChanged: asStringArray(raw.filesChanged),
          verification: rawVerification.map(coerceClaim),
          risks: asStringArray(raw.risks),
          ...(contextUpdate === undefined ? {} : { contextUpdate }),
          trustNotes: [],
        }
      } catch {
        return {
          status: 'failed',
          summary: jsonText.slice(0, MAX_SUMMARY_CHARS),
          filesChanged: [],
          verification: [],
          risks: [],
          trustNotes: ['executor report fence was present but its JSON was malformed; coerced to failed'],
        }
      }
    }
  }
  return {
    status: 'failed',
    summary: finalText.slice(0, MAX_SUMMARY_CHARS),
    filesChanged: [],
    verification: [],
    risks: [],
    trustNotes: ['executor report fence missing from the final message; coerced to failed'],
  }
}
