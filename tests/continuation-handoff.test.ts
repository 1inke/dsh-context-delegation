import { describe, expect, it } from 'vitest'
import {
  buildContinuationHandoff,
  HANDOFF_PAYLOAD_V3_BEGIN,
  HANDOFF_PAYLOAD_V3_END,
  parseContinuationHandoff,
  selectContinuationPayload,
} from '../src/continuation-handoff.ts'
import {
  createSnapshotUnit,
} from '../src/context-fingerprint.ts'
import type { ContextSnapshot, DelegationInput } from '../src/types.ts'
import { computeSha256 } from '../src/context-fingerprint.ts'

function makeTestSnapshot(content: string): ContextSnapshot {
  const unit = createSnapshotUnit({
    sourceId: 'currentState',
    relativePath: 'harness/context/CURRENT_STATE.md',
    headingPath: [],
    partIndex: 0,
    content,
  })
  const policyRevision = 'sha256:policy'
  const revision = `sha256:${computeSha256(JSON.stringify([[unit.id, unit.contentHash]]))}`
  return {
    revision,
    policyRevision,
    units: Object.freeze([unit]),
    missingFiles: Object.freeze([]),
    sourceLimitedFiles: Object.freeze([]),
  }
}

describe('continuation handoff V3 builder', () => {
  const input: DelegationInput = {
    task: 'Implement authentication check',
    relevant_files: ['src/auth.ts'],
    acceptance_criteria: ['Returns 401 when unauthenticated'],
    verification_commands: ['npm test'],
    notes: 'Do not alter token signature',
    mode: 'continue',
    delegation_key: 'auth-work',
  }

  it('builds valid V3 full handoff and escapes line separators', () => {
    const snapshot = makeTestSnapshot('Content with \u2028 line separator \u2029')
    const { handoffText, payload } = buildContinuationHandoff({
      contextMode: 'full',
      snapshot,
      input,
      relevantFiles: ['src/auth.ts'],
    })

    expect(handoffText).toContain(HANDOFF_PAYLOAD_V3_BEGIN)
    expect(handoffText).toContain(HANDOFF_PAYLOAD_V3_END)
    expect(handoffText).not.toContain('\u2028')
    expect(handoffText).not.toContain('\u2029')
    expect(handoffText).toContain('\\u2028')
    expect(handoffText).toContain('\\u2029')

    expect(payload.protocol).toBe('dsh-context-delegation/v3')
    expect(payload.contextMode).toBe('full')
    expect(payload.task).toBe('Implement authentication check')
    expect(payload.relevantFiles).toEqual(['src/auth.ts'])
    expect(payload.context.units?.length).toBe(1)
  })

  it('parses valid V3 handoff payload and rejects delimiter injection or corrupt JSON', () => {
    const snapshot = makeTestSnapshot('Sample content')
    const { handoffText, payload } = buildContinuationHandoff({
      contextMode: 'full',
      snapshot,
      input,
      relevantFiles: ['src/auth.ts'],
    })

    const parsed = parseContinuationHandoff(handoffText)
    expect(parsed).toEqual(payload)

    // Tampered markers
    expect(() => parseContinuationHandoff('No markers here')).toThrowError(/V3 markers/)
    expect(() => parseContinuationHandoff(`${HANDOFF_PAYLOAD_V3_BEGIN} not json ${HANDOFF_PAYLOAD_V3_END}`)).toThrowError()
  })

  it('selects full when no baseSnapshot exists', () => {
    const current = makeTestSnapshot('Current state content')
    const selected = selectContinuationPayload({
      currentSnapshot: current,
      input,
      relevantFiles: ['src/auth.ts'],
    })

    expect(selected.contextMode).toBe('full')
    expect(selected.payload.context.units).toBeDefined()
    expect(selected.payload.context.added).toBeUndefined()
  })

  it('selects delta when baseSnapshot exists and delta is smaller than full', () => {
    // Create large base and small modification
    const largeBase = makeTestSnapshot('Large base '.repeat(100))
    const unitExtra = createSnapshotUnit({
      sourceId: 'projectContext',
      relativePath: 'harness/context/PROJECT_CONTEXT.md',
      headingPath: ['Extra'],
      partIndex: 0,
      content: 'Small addition',
    })
    const updatedUnits = [...largeBase.units, unitExtra]
    const updatedSnapshot: ContextSnapshot = {
      ...largeBase,
      units: Object.freeze(updatedUnits),
      revision: 'sha256:updated',
    }

    const selected = selectContinuationPayload({
      baseSnapshot: largeBase,
      currentSnapshot: updatedSnapshot,
      input,
      relevantFiles: ['src/auth.ts'],
    })

    expect(selected.contextMode).toBe('delta')
    expect(selected.payload.context.added?.length).toBe(1)
    expect(selected.payload.baseRevision).toBe(largeBase.revision)
  })

  it('falls back to full-refresh with delta_not_smaller if delta serialization is not smaller', () => {
    // Single small unit completely changed -> delta overhead (added + removed + metadata) >= full unit
    const base = makeTestSnapshot('A')
    const current = makeTestSnapshot('B')

    const selected = selectContinuationPayload({
      baseSnapshot: base,
      currentSnapshot: current,
      input,
      relevantFiles: ['src/auth.ts'],
    })

    expect(selected.contextMode).toBe('full-refresh')
    expect(selected.payload.refreshReason).toBe('delta_not_smaller')
  })

  it('always carries task, criteria, and verification commands even when context delta is empty', () => {
    const snap = makeTestSnapshot('Stable content '.repeat(50))
    const selected = selectContinuationPayload({
      baseSnapshot: snap,
      currentSnapshot: snap,
      input,
      relevantFiles: ['src/auth.ts'],
    })

    expect(selected.contextMode).toBe('delta')
    expect(selected.payload.context.added).toEqual([])
    expect(selected.payload.context.changed).toEqual([])
    expect(selected.payload.context.removed).toEqual([])
    expect(selected.payload.task).toBe('Implement authentication check')
    expect(selected.payload.verificationCommands).toEqual(['npm test'])
  })
})
