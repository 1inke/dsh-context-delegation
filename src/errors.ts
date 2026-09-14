export const CONTEXT_DELEGATION_ERROR_CODES = [
  'WORKSPACE_NOT_FOUND',
  'INVALID_INPUT',
  'CONTEXT_READ_ERROR',
  'CONTEXT_PATH_ESCAPE',
  'CONTEXT_TOO_LARGE',
  'CODEX_PROVIDER_NOT_FOUND',
  'CODEX_DELEGATION_FAILED',
  'CODEX_CANCELLED',
  'PLUGIN_INTERNAL_ERROR',
  'UNSUPPORTED_CONTINUATION_PROVIDER',
  'DELEGATION_BUSY',
  'SESSION_LIMIT_REACHED',
  'SESSION_EXPIRED',
  'SESSION_INVALIDATED',
  'DELTA_APPLICATION_FAILED',
  'SNAPSHOT_TOO_LARGE',
  'CONTEXT_ACK_FAILED',
  'CONTEXT_REVISION_MISMATCH',
] as const

export type ContextDelegationErrorCode = typeof CONTEXT_DELEGATION_ERROR_CODES[number]

export type ContextDelegationLayer = 'workspace' | 'context' | 'provider' | 'delegation' | 'plugin'

export interface ContextDelegationErrorDetails {
  readonly layer: ContextDelegationLayer
  readonly codexInvoked: boolean
  readonly workspaceMayHaveChanged: boolean
  readonly nextAction: string
}

/** Stable, operator-actionable failure raised by the plugin. */
export class ContextDelegationError extends Error {
  readonly code: ContextDelegationErrorCode
  readonly details: ContextDelegationErrorDetails

  constructor(
    code: ContextDelegationErrorCode,
    message: string,
    details: ContextDelegationErrorDetails,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options)
    this.name = 'ContextDelegationError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}
