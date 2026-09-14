import { describe, expect, it } from 'vitest'
import {
  applyContextDelta,
  diffContextSnapshots,
} from '../src/context-delta.ts'
import {
  createSnapshotUnit,
} from '../src/context-fingerprint.ts'
import type { ContextSnapshot, ContextSnapshotUnit } from '../src/types.ts'
import { computeSha256 } from '../src/context-fingerprint.ts'

function makeTestSnapshot(units: ContextSnapshotUnit[], missingFiles: string[] = []): ContextSnapshot {
  const sortedUnits = [...units].sort((a, b) => a.id.localeCompare(b.id))
  const sortedMissing = [...missingFiles].sort()
  const policyRevision = 'sha256:testpolicy'
  const revisionPayload = JSON.stringify({
    units: sortedUnits.map(u => [u.id, u.contentHash]),
    missingFiles: sortedMissing,
    sourceLimitedFiles: [],
    policyRevision,
  })
  return {
    revision: `sha256:${computeSha256(revisionPayload)}`,
    policyRevision,
    units: Object.freeze(sortedUnits),
    missingFiles: Object.freeze(sortedMissing),
    sourceLimitedFiles: Object.freeze([]),
  }
}

describe('context delta diff and apply', () => {
  const unitA = createSnapshotUnit({
    sourceId: 'currentState',
    relativePath: 'harness/context/CURRENT_STATE.md',
    headingPath: [],
    partIndex: 0,
    content: 'Current state initial',
  })

  const unitB = createSnapshotUnit({
    sourceId: 'projectContext',
    relativePath: 'harness/context/PROJECT_CONTEXT.md',
    headingPath: ['Section 1'],
    partIndex: 0,
    content: 'Section 1 content',
  })

  const unitC = createSnapshotUnit({
    sourceId: 'projectContext',
    relativePath: 'harness/context/PROJECT_CONTEXT.md',
    headingPath: ['Section 2'],
    partIndex: 0,
    content: 'Section 2 content',
  })

  it('computes empty delta when snapshots are identical', () => {
    const snap1 = makeTestSnapshot([unitA, unitB])
    const snap2 = makeTestSnapshot([unitA, unitB])

    const delta = diffContextSnapshots(snap1, snap2)

    expect(delta.baseRevision).toBe(snap1.revision)
    expect(delta.revision).toBe(snap2.revision)
    expect(delta.added).toEqual([])
    expect(delta.changed).toEqual([])
    expect(delta.removed).toEqual([])
  })

  it('correctly identifies added, changed, and removed units', () => {
    const snap1 = makeTestSnapshot([unitA, unitB])

    const unitAChanged = createSnapshotUnit({
      sourceId: 'currentState',
      relativePath: 'harness/context/CURRENT_STATE.md',
      headingPath: [],
      partIndex: 0,
      content: 'Current state updated',
    })

    // snap2 has unitAChanged (changed), unitC (added), unitB is gone (removed)
    const snap2 = makeTestSnapshot([unitAChanged, unitC])

    const delta = diffContextSnapshots(snap1, snap2)

    expect(delta.added).toEqual([unitC])
    expect(delta.changed).toEqual([unitAChanged])
    expect(delta.removed).toEqual([{ id: unitB.id }])
  })

  it('verifies round-trip invariant: apply(A, diff(A, B)) === B', () => {
    const snapA = makeTestSnapshot([unitA, unitB])

    const unitAUpdated = createSnapshotUnit({
      sourceId: 'currentState',
      relativePath: 'harness/context/CURRENT_STATE.md',
      headingPath: [],
      partIndex: 0,
      content: 'Current state modified',
    })

    const snapB = makeTestSnapshot([unitAUpdated, unitC])

    const delta = diffContextSnapshots(snapA, snapB)
    const reconstructed = applyContextDelta(snapA, delta)

    expect(reconstructed).toEqual(snapB)
    expect(reconstructed.revision).toBe(snapB.revision)
  })

  it('rejects delta if baseRevision does not match base snapshot', () => {
    const snapA = makeTestSnapshot([unitA])
    const snapB = makeTestSnapshot([unitB])
    const delta = diffContextSnapshots(snapA, snapB)

    const invalidBase = makeTestSnapshot([unitC])

    expect(() => applyContextDelta(invalidBase, delta)).toThrowError(/DELTA_APPLICATION_FAILED/)
  })

  it('rejects forged delta with tampered contentHash', () => {
    const snapA = makeTestSnapshot([unitA])
    const unitATampered = {
      ...unitA,
      contentHash: 'forged_hash',
    }

    const delta = {
      baseRevision: snapA.revision,
      revision: 'sha256:fakerev',
      policyRevision: snapA.policyRevision,
      added: [],
      changed: [unitATampered],
      removed: [],
      missingFiles: [],
      sourceLimitedFiles: [],
    }

    expect(() => applyContextDelta(snapA, delta)).toThrowError(/DELTA_APPLICATION_FAILED/)
  })

  it('rejects delta with overlapping added/changed/removed ids', () => {
    const snapA = makeTestSnapshot([unitA])
    const delta = {
      baseRevision: snapA.revision,
      revision: 'sha256:fakerev',
      policyRevision: snapA.policyRevision,
      added: [unitB],
      changed: [],
      removed: [{ id: unitB.id }], // unitB in both added and removed
      missingFiles: [],
      sourceLimitedFiles: [],
    }

    expect(() => applyContextDelta(snapA, delta)).toThrowError(/DELTA_APPLICATION_FAILED/)
  })

  it('rejects delta attempting to remove non-existent unit', () => {
    const snapA = makeTestSnapshot([unitA])
    const delta = {
      baseRevision: snapA.revision,
      revision: 'sha256:fakerev',
      policyRevision: snapA.policyRevision,
      added: [],
      changed: [],
      removed: [{ id: 'non_existent_id' }],
      missingFiles: [],
      sourceLimitedFiles: [],
    }

    expect(() => applyContextDelta(snapA, delta)).toThrowError(/DELTA_APPLICATION_FAILED/)
  })
})
