import type { Context } from '@deepseek-ai/cordis'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import {
  boundedProviderDiagnostic,
  classifyPublishedSettlement,
  settlePublishedCodexRun,
  textFromContentBlocks,
} from '../delegation-lifecycle.ts'
import { ContextDelegationError } from '../errors.ts'
import type { DelegationExecution } from '../types.ts'
import type { DelegationExecutor, ExecutorRequest, ExecutorResult } from './types.ts'

export type { DelegationExecutor, ExecutorRequest, ExecutorResult } from './types.ts'

export class SubagentExecutor implements DelegationExecutor {
  constructor(
    private readonly ctx: Context,
    private readonly provider: string,
    private readonly model?: string,
  ) {}

  get id(): string {
    return this.provider
  }

  available(): boolean {
    return this.ctx.subagents.getProvider(this.provider) !== undefined
  }

  async execute(request: ExecutorRequest, execution: DelegationExecution): Promise<ExecutorResult> {
    const { parent, signal } = execution
    if (!this.available()) {
      throw new ContextDelegationError(
        'CODEX_PROVIDER_NOT_FOUND',
        `No subagent provider is registered as "${this.provider}".`,
        {
          layer: 'provider',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: `Load or repair the provider "${this.provider}" before retrying.`,
        },
      )
    }
    // agentOptions (model routing) requires the provider to advertise the
    // capability; an unsupported provider fails loud instead of silently
    // dropping the operator's configured model.
    const agentOptions = this.model === undefined ? undefined : { model: this.model }
    let run
    try {
      run = await this.ctx.subagents.start(this.provider, {
        label: request.label,
        prompt: [{ type: 'text', text: request.promptText }],
        parent,
        signal,
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
    } catch (error: unknown) {
      if (error instanceof ContextDelegationError) throw error
      // A provider deregistered between available() and start() is a loud
      // configuration error, not an infrastructure failure.
      if (error instanceof SubagentError && error.code === 'NO_PROVIDER') {
        throw new ContextDelegationError(
          'CODEX_PROVIDER_NOT_FOUND',
          `No subagent provider is registered as "${this.provider}".`,
          {
            layer: 'provider',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: `Load or repair the provider "${this.provider}" before retrying.`,
          },
          { cause: error },
        )
      }
      if (signal.aborted && !(error instanceof AggregateError)) {
        throw new ContextDelegationError(
          'CODEX_CANCELLED',
          `The "${this.provider}" executor was cancelled while starting.`,
          {
            layer: 'delegation',
            codexInvoked: true,
            workspaceMayHaveChanged: true,
            nextAction: 'Inspect the workspace before retrying because startup may have reached the backend.',
          },
          { cause: error },
        )
      }
      throw new ContextDelegationError(
        'CODEX_DELEGATION_FAILED',
        `Executor "${this.provider}" failed to start.`,
        {
          layer: 'delegation',
          codexInvoked: true,
          workspaceMayHaveChanged: true,
          nextAction: 'Inspect the workspace, then check the executor provider and retry if safe.',
        },
        { cause: error },
      )
    }
    const settlement = await settlePublishedCodexRun(run)
    const result = classifyPublishedSettlement(settlement, signal)
    const diagnostic = boundedProviderDiagnostic(result.diagnostic)
    return {
      runId: String(run.id),
      finalText: textFromContentBlocks(result.output),
      ...(diagnostic === undefined ? {} : { providerDiagnostic: diagnostic }),
    }
  }
}
