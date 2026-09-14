import { computeContentHash, computeSha256 } from './fingerprint.ts'
import { ContextDelegationError } from '../errors.ts'
import type { ContextDelta, ContextSnapshot, ContextSnapshotUnit } from '../types.ts'

/**
 * Compute the deterministic delta between base and target ContextSnapshots.
 */
export function diffContextSnapshots(
  base: ContextSnapshot,
  target: ContextSnapshot,
): ContextDelta {
  const baseMap = new Map<string, ContextSnapshotUnit>(base.units.map(u => [u.id, u]))
  const targetMap = new Map<string, ContextSnapshotUnit>(target.units.map(u => [u.id, u]))

  const added: ContextSnapshotUnit[] = []
  const changed: ContextSnapshotUnit[] = []
  const removed: { id: string }[] = []

  for (const [id, targetUnit] of targetMap.entries()) {
    const baseUnit = baseMap.get(id)
    if (!baseUnit) {
      added.push(targetUnit)
    } else if (baseUnit.contentHash !== targetUnit.contentHash) {
      changed.push(targetUnit)
    }
  }

  for (const id of baseMap.keys()) {
    if (!targetMap.has(id)) {
      removed.push({ id })
    }
  }

  added.sort((a, b) => a.id.localeCompare(b.id))
  changed.sort((a, b) => a.id.localeCompare(b.id))
  removed.sort((a, b) => a.id.localeCompare(b.id))

  return Object.freeze({
    baseRevision: base.revision,
    revision: target.revision,
    policyRevision: target.policyRevision,
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    removed: Object.freeze(removed),
    missingFiles: Object.freeze([...target.missingFiles]),
    sourceLimitedFiles: Object.freeze([...target.sourceLimitedFiles]),
  })
}

/**
 * Pure function to validate and apply a ContextDelta to a base ContextSnapshot.
 * Invariant: applyContextDelta(A, diffContextSnapshots(A, B)) === B
 */
export function applyContextDelta(
  base: ContextSnapshot,
  delta: ContextDelta,
): ContextSnapshot {
  if (base.revision !== delta.baseRevision) {
    throw new ContextDelegationError(
      'DELTA_APPLICATION_FAILED',
      `Base revision mismatch: base snapshot is ${base.revision} but delta expects ${delta.baseRevision}.`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Perform a FULL_REFRESH to synchronize state.',
      },
    )
  }

  const baseMap = new Map<string, ContextSnapshotUnit>(base.units.map(u => [u.id, u]))
  const addedIds = new Set<string>()
  const changedIds = new Set<string>()
  const removedIds = new Set<string>()

  for (const unit of delta.added) {
    if (addedIds.has(unit.id) || baseMap.has(unit.id)) {
      throw new ContextDelegationError(
        'DELTA_APPLICATION_FAILED',
        `Invalid delta: added unit "${unit.id}" already exists or appears multiple times.`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reject delta and trigger FULL_REFRESH.',
        },
      )
    }
    if (computeContentHash(unit.content) !== unit.contentHash) {
      throw new ContextDelegationError(
        'DELTA_APPLICATION_FAILED',
        `Invalid delta: contentHash mismatch for added unit "${unit.id}".`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reject delta and trigger FULL_REFRESH.',
        },
      )
    }
    addedIds.add(unit.id)
  }

  for (const unit of delta.changed) {
    if (changedIds.has(unit.id) || addedIds.has(unit.id) || !baseMap.has(unit.id)) {
      throw new ContextDelegationError(
        'DELTA_APPLICATION_FAILED',
        `Invalid delta: changed unit "${unit.id}" is missing from base or overlaps with added.`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reject delta and trigger FULL_REFRESH.',
        },
      )
    }
    if (computeContentHash(unit.content) !== unit.contentHash) {
      throw new ContextDelegationError(
        'DELTA_APPLICATION_FAILED',
        `Invalid delta: contentHash mismatch for changed unit "${unit.id}".`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reject delta and trigger FULL_REFRESH.',
        },
      )
    }
    changedIds.add(unit.id)
  }

  for (const rem of delta.removed) {
    if (removedIds.has(rem.id) || addedIds.has(rem.id) || changedIds.has(rem.id) || !baseMap.has(rem.id)) {
      throw new ContextDelegationError(
        'DELTA_APPLICATION_FAILED',
        `Invalid delta: removed unit "${rem.id}" is missing from base or overlaps with added/changed.`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reject delta and trigger FULL_REFRESH.',
        },
      )
    }
    removedIds.add(rem.id)
  }

  // Apply transformations
  for (const id of removedIds) {
    baseMap.delete(id)
  }
  for (const unit of delta.changed) {
    baseMap.set(unit.id, unit)
  }
  for (const unit of delta.added) {
    baseMap.set(unit.id, unit)
  }

  const updatedUnits = Object.freeze(
    Array.from(baseMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
  )

  const sortedMissing = Object.freeze([...delta.missingFiles].sort())
  const sortedSourceLimited = Object.freeze([...delta.sourceLimitedFiles].sort())

  const revisionPayload = JSON.stringify({
    units: updatedUnits.map(u => [u.id, u.contentHash]),
    missingFiles: sortedMissing,
    sourceLimitedFiles: sortedSourceLimited,
    policyRevision: delta.policyRevision,
  })

  const computedRevision = `sha256:${computeSha256(revisionPayload)}`
  if (computedRevision !== delta.revision) {
    throw new ContextDelegationError(
      'DELTA_APPLICATION_FAILED',
      `Target revision mismatch: expected ${delta.revision}, computed ${computedRevision}.`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Reject delta and trigger FULL_REFRESH.',
      },
    )
  }

  return Object.freeze({
    revision: computedRevision,
    policyRevision: delta.policyRevision,
    units: updatedUnits,
    missingFiles: sortedMissing,
    sourceLimitedFiles: sortedSourceLimited,
  })
}
