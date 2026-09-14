import { describe, expect, it } from 'vitest'
import {
  ContextDelegationError,
  createContextFilePlan,
  DEFAULT_TRUNCATION_NOTICE,
  renderCodexExpertResult,
  resolveConfig,
} from '../src/index.ts'

describe('Block 1 contracts', () => {
  it('preserves the V0.1 file plan and adds explicit V0.2 selection defaults', () => {
    const config = resolveConfig()
    expect(config).toEqual({
      contextMode: 'lexical',
      contextMinRelativeScore: 0.3,
      contextBudgets: { mandatory: 14_000, project: 8_000, decisions: 8_000, experiments: 8_000 },
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
      executorRouting: {
        implementation: { provider: 'codex' },
        reviewer: { provider: 'codex' },
      },
      contextWriteback: 'proposal',
      cacheEnabled: true,
    })
    expect(createContextFilePlan(config).map(entry => entry.relativePath)).toEqual([
      'AGENTS.md',
      'harness/context/CURRENT_STATE.md',
      'harness/context/PROJECT_CONTEXT.md',
      'harness/context/CODEX_HANDOFF.md',
      'harness/context/DECISIONS.md',
      'harness/context/EXPERIMENTS.md',
    ])
  })

  it('honors inclusion flags without reordering remaining files', () => {
    const config = resolveConfig({ includeAgents: false, includeDecisions: false })
    expect(createContextFilePlan(config).map(entry => entry.id)).toEqual([
      'currentState', 'projectContext', 'handoffRules', 'experiments',
    ])
  })

  it.each(['../context', '/absolute/context', 'C:\\context', 'harness//context'])(
    'rejects unsafe contextRoot %s',
    (contextRoot) => {
      expect(() => resolveConfig({ contextRoot })).toThrow(ContextDelegationError)
    },
  )

  it('rejects invalid tool names and context budgets before Codex can run', () => {
    expect(() => resolveConfig({ toolName: 'Codex Expert' })).toThrow('[PLUGIN_INTERNAL_ERROR]')
    expect(() => resolveConfig({ maxContextChars: 1.5 })).toThrow('[PLUGIN_INTERNAL_ERROR]')
    expect(() => resolveConfig({ maxContextChars: 1_000_001 })).toThrow('[PLUGIN_INTERNAL_ERROR]')
  })

  it('preserves stable error codes and operator metadata', () => {
    const error = new ContextDelegationError('CODEX_PROVIDER_NOT_FOUND', 'Provider codex is absent.', {
      layer: 'provider',
      codexInvoked: false,
      workspaceMayHaveChanged: false,
      nextAction: 'Check the Host provider row.',
    })
    expect(error.message).toBe('[CODEX_PROVIDER_NOT_FOUND] Provider codex is absent.')
    expect(error.details).toEqual({
      layer: 'provider',
      codexInvoked: false,
      workspaceMayHaveChanged: false,
      nextAction: 'Check the Host provider row.',
    })
  })

  it('renders the canonical success value with a parent-verification warning', () => {
    const text = renderCodexExpertResult({
      success: true,
      provider: 'codex',
      workspaceRoot: 'C:/repo',
      contextFilesLoaded: ['AGENTS.md'],
      contextFilesMissing: [],
      contextFilesTruncated: [],
      contextChars: 123,
      runId: 'run-1',
      codexFinal: 'Implemented the requested change.',
      parentVerificationRequired: true,
    })
    expect(text).toContain('Implemented the requested change.')
    expect(text).toContain('The parent agent must independently verify')
  })
})

describe('Block 2 S2-0 frozen contracts', () => {
  it('freezes the default truncation notice length at exactly 72 UTF-16 code units', () => {
    expect(DEFAULT_TRUNCATION_NOTICE).toBe(
      '\n\n[... truncated by dsh-context-delegation: maxContextChars reached ...]',
    )
    expect(DEFAULT_TRUNCATION_NOTICE.length).toBe(72)
    expect(DEFAULT_TRUNCATION_NOTICE.startsWith('\n\n')).toBe(true)
  })

  it.each([
    [
      'WORKSPACE_NOT_FOUND' as const,
      'workspace' as const,
      'Ensure the calling agent has an active session with a valid cwd.',
    ],
    [
      'CONTEXT_PATH_ESCAPE' as const,
      'context' as const,
      'Ensure all context and relevant files reside strictly within the workspace root.',
    ],
    [
      'CONTEXT_TOO_LARGE' as const,
      'context' as const,
      'Reduce the size of AGENTS.md or increase maxContextChars in plugin configuration.',
    ],
    [
      'CONTEXT_READ_ERROR' as const,
      'context' as const,
      'Verify file readability, permissions, and ensure context paths are regular files.',
    ],
    [
      'CODEX_CANCELLED' as const,
      'delegation' as const,
      'Retry the delegation request without cancelling the execution signal.',
    ],
  ])('validates Block 2 error metadata for %s', (code, layer, nextAction) => {
    const error = new ContextDelegationError(code, 'Test message', {
      layer,
      codexInvoked: false,
      workspaceMayHaveChanged: false,
      nextAction,
    })
    expect(error.code).toBe(code)
    expect(error.details.layer).toBe(layer)
    expect(error.details.codexInvoked).toBe(false)
    expect(error.details.workspaceMayHaveChanged).toBe(false)
    expect(error.details.nextAction).toBe(nextAction)
  })
})
