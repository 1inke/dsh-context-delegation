import type { DelegationExecution } from '../types.ts'

export interface ExecutorRequest {
  readonly label: string
  readonly promptText: string
}

export interface ExecutorResult {
  readonly runId: string
  readonly finalText: string
  readonly providerDiagnostic?: string
}

export interface DelegationExecutor {
  /** Stable executor identity (the routed provider name). */
  readonly id: string
  /** True when the backing provider is currently registered. */
  available(): boolean
  /** Run one foreground one-shot request to quiescence. */
  execute(request: ExecutorRequest, execution: DelegationExecution): Promise<ExecutorResult>
}
