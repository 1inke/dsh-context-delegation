import { diffContextSnapshots } from '../context/delta.ts'
import { ContextDelegationError } from '../errors.ts'
import type {
  DelegationInput,
  ContextDelta,
  ContextSnapshot,
  ContextSnapshotUnit,
} from '../types.ts'

export const HANDOFF_PAYLOAD_V3_BEGIN = '<!--- DSH_CONTEXT_DELEGATION_V3_BEGIN --->'
export const HANDOFF_PAYLOAD_V3_END = '<!--- DSH_CONTEXT_DELEGATION_V3_END --->'

export interface ContinuationHandoffPayload {
  readonly protocol: 'dsh-context-delegation/v3'
  readonly contextMode: 'full' | 'delta' | 'full-refresh'
  readonly baseRevision?: string | undefined
  readonly revision: string
  readonly policyRevision: string
  readonly refreshReason?: string | undefined
  readonly context: {
    readonly units?: readonly ContextSnapshotUnit[]
    readonly added?: readonly ContextSnapshotUnit[]
    readonly changed?: readonly ContextSnapshotUnit[]
    readonly removed?: readonly { readonly id: string }[]
  }
  readonly missingFiles: readonly string[]
  readonly sourceLimitedFiles: readonly string[]
  readonly task: string
  readonly relevantFiles: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly verificationCommands: readonly string[]
  readonly notes: string | null
}

function escapeLineSeparators(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function buildContinuationHandoff(options: {
  contextMode: 'full' | 'delta' | 'full-refresh'
  snapshot: ContextSnapshot
  delta?: ContextDelta | undefined
  input: DelegationInput
  relevantFiles: readonly string[]
  refreshReason?: string | undefined
}): { handoffText: string; payload: ContinuationHandoffPayload; handoffBytes: number } {
  const { contextMode, snapshot, delta, input, relevantFiles, refreshReason } = options

  let contextPayload: ContinuationHandoffPayload['context']
  let baseRevision: string | undefined

  if (contextMode === 'delta') {
    if (!delta) {
      throw new ContextDelegationError(
        'PLUGIN_INTERNAL_ERROR',
        'Delta object is required when contextMode is delta.',
        {
          layer: 'plugin',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Internal error: provide delta.',
        },
      )
    }
    baseRevision = delta.baseRevision
    contextPayload = {
      added: delta.added,
      changed: delta.changed,
      removed: delta.removed,
    }
  } else {
    contextPayload = {
      units: snapshot.units,
    }
  }

  const payload: ContinuationHandoffPayload = Object.freeze({
    protocol: 'dsh-context-delegation/v3',
    contextMode,
    ...(baseRevision !== undefined ? { baseRevision } : {}),
    revision: snapshot.revision,
    policyRevision: snapshot.policyRevision,
    ...(refreshReason !== undefined ? { refreshReason } : {}),
    context: Object.freeze(contextPayload),
    missingFiles: Object.freeze([...snapshot.missingFiles]),
    sourceLimitedFiles: Object.freeze([...snapshot.sourceLimitedFiles]),
    task: input.task,
    relevantFiles: Object.freeze([...relevantFiles]),
    acceptanceCriteria: Object.freeze([...(input.acceptance_criteria ?? [])]),
    verificationCommands: Object.freeze([...(input.verification_commands ?? [])]),
    notes: input.notes ?? null,
  })

  const rawJson = JSON.stringify(payload, null, 2)
  const escapedLineSeparators = escapeLineSeparators(rawJson)
  // Safely escape any delimiter tokens within JSON string values so delimiters in task do not break framing
  const escapedJson = escapedLineSeparators.replaceAll('<!--- DSH_CONTEXT_DELEGATION_V3_', '\\u003c!--- DSH_CONTEXT_DELEGATION_V3_')

  const instructions = [
    '# Context Protocol Instructions',
    'Apply the context payload enclosed below. Upon understanding and applying this context, you MUST acknowledge receipt by outputting the following exact acknowledgment marker in your response:',
    `[DSH_CONTEXT_ACK: revision=${payload.revision}${payload.baseRevision ? ` baseRevision=${payload.baseRevision}` : ''}]`,
    '',
  ].join('\n')

  const handoffText = `${instructions}${HANDOFF_PAYLOAD_V3_BEGIN}\n${escapedJson}\n${HANDOFF_PAYLOAD_V3_END}`
  const handoffBytes = Buffer.byteLength(handoffText, 'utf8')

  return { handoffText, payload, handoffBytes }
}

export interface ContextAckInfo {
  valid: boolean
  acknowledgedRevision?: string | undefined
  acknowledgedBaseRevision?: string | undefined
  error?: 'MISSING_ACK' | 'MULTIPLE_ACKS' | 'MALFORMED_ACK' | undefined
}

/** Extract and validate context revision ACK marker from assistant response text. */
export function extractContextAck(text: string): ContextAckInfo {
  const matches = [...text.matchAll(/\[DSH_CONTEXT_ACK:\s*([^\]]+)\]/gi)]
  if (matches.length === 0) {
    return { valid: false, error: 'MISSING_ACK' }
  }
  if (matches.length > 1) {
    return { valid: false, error: 'MULTIPLE_ACKS' }
  }

  const firstMatch = matches[0]
  if (!firstMatch || firstMatch[1] === undefined) {
    return { valid: false, error: 'MALFORMED_ACK' }
  }

  const rawParams = firstMatch[1]
  const revisionMatch = /revision=([^\s\]]+)/i.exec(rawParams)
  const baseRevisionMatch = /baseRevision=([^\s\]]+)/i.exec(rawParams)

  if (!revisionMatch || revisionMatch[1] === undefined) {
    return { valid: false, error: 'MALFORMED_ACK' }
  }

  return {
    valid: true,
    acknowledgedRevision: revisionMatch[1],
    acknowledgedBaseRevision: baseRevisionMatch?.[1],
  }
}

export function parseContinuationHandoff(text: string): ContinuationHandoffPayload {
  const beginIndex = text.indexOf(HANDOFF_PAYLOAD_V3_BEGIN)
  const endIndex = text.lastIndexOf(HANDOFF_PAYLOAD_V3_END)

  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    throw new ContextDelegationError(
      'PLUGIN_INTERNAL_ERROR',
      'Missing or malformed V3 markers in handoff payload.',
      {
        layer: 'plugin',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure handoff payload is enclosed in V3 markers.',
      },
    )
  }

  const jsonText = text
    .slice(beginIndex + HANDOFF_PAYLOAD_V3_BEGIN.length, endIndex)
    .trim()

  try {
    const payload = JSON.parse(jsonText) as ContinuationHandoffPayload
    if (payload.protocol !== 'dsh-context-delegation/v3') {
      throw new Error(`Unexpected protocol version: ${payload.protocol}`)
    }
    return payload
  } catch (error: unknown) {
    throw new ContextDelegationError(
      'PLUGIN_INTERNAL_ERROR',
      `Failed to parse V3 handoff payload JSON: ${String(error)}`,
      {
        layer: 'plugin',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure handoff payload is valid JSON.',
      },
      { cause: error },
    )
  }
}

export function selectContinuationPayload(options: {
  baseSnapshot?: ContextSnapshot | undefined
  currentSnapshot: ContextSnapshot
  input: DelegationInput
  relevantFiles: readonly string[]
  refreshReason?: string | undefined
}): {
  payload: ContinuationHandoffPayload
  contextMode: 'full' | 'delta' | 'full-refresh'
  handoffText: string
  handoffBytes: number
} {
  const { baseSnapshot, currentSnapshot, input, relevantFiles, refreshReason } = options

  // 1. Forced refresh if refreshReason provided
  if (refreshReason !== undefined) {
    const fullRefresh = buildContinuationHandoff({
      contextMode: 'full-refresh',
      snapshot: currentSnapshot,
      input,
      relevantFiles,
      refreshReason,
    })
    return {
      payload: fullRefresh.payload,
      contextMode: 'full-refresh',
      handoffText: fullRefresh.handoffText,
      handoffBytes: fullRefresh.handoffBytes,
    }
  }

  // 2. Initial continue run without baseSnapshot -> full
  if (!baseSnapshot) {
    const full = buildContinuationHandoff({
      contextMode: 'full',
      snapshot: currentSnapshot,
      input,
      relevantFiles,
    })
    return {
      payload: full.payload,
      contextMode: 'full',
      handoffText: full.handoffText,
      handoffBytes: full.handoffBytes,
    }
  }

  // 3. Compare delta vs full-refresh size
  const delta = diffContextSnapshots(baseSnapshot, currentSnapshot)
  const deltaHandoff = buildContinuationHandoff({
    contextMode: 'delta',
    snapshot: currentSnapshot,
    delta,
    input,
    relevantFiles,
  })

  const fullHandoff = buildContinuationHandoff({
    contextMode: 'full-refresh',
    snapshot: currentSnapshot,
    input,
    relevantFiles,
    refreshReason: 'delta_not_smaller',
  })

  if (deltaHandoff.handoffBytes < fullHandoff.handoffBytes) {
    return {
      payload: deltaHandoff.payload,
      contextMode: 'delta',
      handoffText: deltaHandoff.handoffText,
      handoffBytes: deltaHandoff.handoffBytes,
    }
  }

  return {
    payload: fullHandoff.payload,
    contextMode: 'full-refresh',
    handoffText: fullHandoff.handoffText,
    handoffBytes: fullHandoff.handoffBytes,
  }
}
