import { posix, win32 } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { ContextDelegationError } from './errors.ts'
import { resolveExecutorRouting } from './executor-routing.ts'
import type { ResolvedExecutorRouting } from './types.ts'
import type {
  ContextDelegationConfig,
  ResolvedContextDelegationConfig,
} from './types.ts'

/** Operational ceiling that keeps caller-controlled configuration memory-safe. */
export const MAX_CONTEXT_CHARS_HARD_LIMIT = 1_000_000

export const DEFAULT_CONTEXT_DELEGATION_CONFIG: ResolvedContextDelegationConfig = Object.freeze({
  contextMode: 'lexical',
  contextMinRelativeScore: 0.3,
  contextBudgets: Object.freeze({ mandatory: 14_000, project: 8_000, decisions: 8_000, experiments: 8_000 }),
  providerName: 'codex',
  toolName: 'codex_expert',
  contextRoot: 'harness/context',
  maxContextChars: 40_000,
  includeAgents: true,
  includeProjectContext: true,
  includeCurrentState: true,
  includeDecisions: true,
  includeExperiments: true,
  includeHandoffRules: true,
  continuationEnabled: false,
  continuationProviderName: 'spawn',
  requireContextAck: true,
  maxSessions: 8,
  idleTtlMs: 15 * 60 * 1000,
  maxSnapshotBytes: 1024 * 1024,
  maxReviewRounds: 1,
  verificationTimeoutMs: 120_000,
  verificationMaxOutputChars: 16_000,
  reviewProviderName: 'codex',
  executorRouting: Object.freeze({
    implementation: Object.freeze({ provider: 'codex' }),
    reviewer: Object.freeze({ provider: 'codex' }),
  }) as unknown as ResolvedExecutorRouting,
  contextWriteback: 'proposal',
  cacheEnabled: true,
})

export const Config: Schema<ContextDelegationConfig> = z.object({
  contextMode: z.union(['lexical', 'legacy']).default('lexical'),
  contextMinRelativeScore: z.number().min(0).max(1).default(0.3),
  contextBudgets: z.object({
    mandatory: z.number().min(0),
    project: z.number().min(0),
    decisions: z.number().min(0),
    experiments: z.number().min(0),
  }),
  providerName: z.string().min(1).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.providerName),
  toolName: z.string().min(1).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.toolName),
  contextRoot: z.string().min(1).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.contextRoot),
  maxContextChars: z.number().min(1).max(MAX_CONTEXT_CHARS_HARD_LIMIT).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.maxContextChars),
  includeAgents: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.includeAgents),
  includeProjectContext: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.includeProjectContext),
  includeCurrentState: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.includeCurrentState),
  includeDecisions: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.includeDecisions),
  includeExperiments: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.includeExperiments),
  includeHandoffRules: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.includeHandoffRules),
  continuationEnabled: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.continuationEnabled),
  continuationProviderName: z.string().min(1).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.continuationProviderName),
  requireContextAck: z.boolean().default(DEFAULT_CONTEXT_DELEGATION_CONFIG.requireContextAck),
  maxSessions: z.number().min(1).max(64).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.maxSessions),
  idleTtlMs: z.number().min(1000).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.idleTtlMs),
  maxSnapshotBytes: z.number().min(1024).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.maxSnapshotBytes),
  maxReviewRounds: z.number().min(0).max(5).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.maxReviewRounds),
  verificationTimeoutMs: z.number().min(1000).max(600000).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.verificationTimeoutMs),
  verificationMaxOutputChars: z.number().min(1000).max(100000).default(DEFAULT_CONTEXT_DELEGATION_CONFIG.verificationMaxOutputChars),
  reviewProviderName: z.string().min(1).default(undefined as unknown as string),
  executorRouting: z.any(),
  contextWriteback: z.union(['disabled', 'proposal', 'apply']).default('proposal'),
  cacheEnabled: z.boolean().default(true),
})

function configError(message: string): ContextDelegationError {
  return new ContextDelegationError('PLUGIN_INTERNAL_ERROR', message, {
    layer: 'plugin',
    codexInvoked: false,
    workspaceMayHaveChanged: false,
    nextAction: 'Correct the dsh-context-delegation Host configuration and restart DSH.',
  })
}

/** Apply defaults and reject ambiguous or unsafe deployment configuration. */
export function resolveConfig(config: ContextDelegationConfig = {}): ResolvedContextDelegationConfig {
  const contextMode = config.contextMode ?? 'lexical'
  const contextMinRelativeScore = config.contextMinRelativeScore ?? 0.3
  if (!Number.isFinite(contextMinRelativeScore) || contextMinRelativeScore < 0 || contextMinRelativeScore > 1) {
    throw configError('contextMinRelativeScore must be between 0 and 1.')
  }
  if (contextMode !== 'lexical' && contextMode !== 'legacy') throw configError('contextMode must be lexical or legacy.')
  const providerName = config.providerName ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.providerName
  const toolName = config.toolName ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.toolName
  const rawContextRoot = config.contextRoot ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.contextRoot
  const maxContextChars = config.maxContextChars ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.maxContextChars

  if (providerName.trim() !== providerName || providerName.length === 0) {
    throw configError('providerName must be non-empty and have no surrounding whitespace.')
  }
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    throw configError('toolName must start with a lowercase letter and contain only lowercase letters, digits, or underscores.')
  }
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars <= 0 || maxContextChars > MAX_CONTEXT_CHARS_HARD_LIMIT) {
    throw configError(`maxContextChars must be a positive safe integer no greater than ${MAX_CONTEXT_CHARS_HARD_LIMIT}.`)
  }
  if (posix.isAbsolute(rawContextRoot) || win32.isAbsolute(rawContextRoot)) {
    throw configError('contextRoot must be relative to the authoritative workspace root.')
  }

  const contextRoot = rawContextRoot.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  const segments = contextRoot.split('/')
  if (contextRoot.length === 0 || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw configError('contextRoot must be a normalized relative path without empty, dot, or parent segments.')
  }

  const defaults = DEFAULT_CONTEXT_DELEGATION_CONFIG.contextBudgets
  const contextBudgets = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
    key, config.contextBudgets?.[key as keyof typeof defaults]
      ?? Math.floor(value * maxContextChars / DEFAULT_CONTEXT_DELEGATION_CONFIG.maxContextChars),
  ])) as unknown as typeof defaults
  if (config.contextBudgets && Object.keys(config.contextBudgets).some(key => !(key in defaults))) {
    throw configError('Unknown context budget category.')
  }
  if (Object.values(contextBudgets).some(value => !Number.isSafeInteger(value) || value < 0)
    || Object.values(contextBudgets).reduce((sum, value) => sum + value, 0) > maxContextChars) {
    throw configError('Context budgets must be non-negative integers whose sum does not exceed maxContextChars.')
  }
  const continuationProviderName = config.continuationProviderName ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.continuationProviderName
  const maxSessions = config.maxSessions ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.maxSessions
  const idleTtlMs = config.idleTtlMs ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.idleTtlMs
  const maxSnapshotBytes = config.maxSnapshotBytes ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.maxSnapshotBytes
  const maxReviewRounds = config.maxReviewRounds ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.maxReviewRounds
  const verificationTimeoutMs = config.verificationTimeoutMs ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.verificationTimeoutMs
  const verificationMaxOutputChars = config.verificationMaxOutputChars ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.verificationMaxOutputChars
  const reviewProviderName = config.reviewProviderName ?? providerName

  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0 || maxSessions > 64) {
    throw configError('maxSessions must be a positive integer no greater than 64.')
  }
  if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1000) {
    throw configError('idleTtlMs must be a positive integer no less than 1000ms.')
  }
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1024) {
    throw configError('maxSnapshotBytes must be a positive integer no less than 1024.')
  }

  return Object.freeze({
    contextMode,
    contextMinRelativeScore,
    contextBudgets: Object.freeze(contextBudgets),
    providerName,
    toolName,
    contextRoot,
    maxContextChars,
    includeAgents: config.includeAgents ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.includeAgents,
    includeProjectContext: config.includeProjectContext ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.includeProjectContext,
    includeCurrentState: config.includeCurrentState ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.includeCurrentState,
    includeDecisions: config.includeDecisions ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.includeDecisions,
    includeExperiments: config.includeExperiments ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.includeExperiments,
    includeHandoffRules: config.includeHandoffRules ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.includeHandoffRules,
    continuationEnabled: config.continuationEnabled ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.continuationEnabled,
    continuationProviderName,
    requireContextAck: config.requireContextAck ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.requireContextAck,
    maxSessions,
    idleTtlMs,
    maxSnapshotBytes,
    maxReviewRounds,
    verificationTimeoutMs,
    verificationMaxOutputChars,
    reviewProviderName,
    executorRouting: resolveExecutorRouting({
      providerName,
      reviewProviderName,
      ...(config.executorRouting === undefined ? {} : { executorRouting: config.executorRouting }),
    }),
    contextWriteback: config.contextWriteback ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.contextWriteback,
    cacheEnabled: config.cacheEnabled ?? DEFAULT_CONTEXT_DELEGATION_CONFIG.cacheEnabled,
  })
}
