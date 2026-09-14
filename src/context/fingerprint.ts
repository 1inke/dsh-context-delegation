import { createHash } from 'node:crypto'
import { ContextDelegationError } from '../errors.ts'
import type {
  ContextBudgets,
  ContextBundle,
  ContextFileId,
  ContextSnapshot,
  ContextSnapshotUnit,
  LoadedContextFile,
  ScoredContextChunk,
} from '../types.ts'

/** Compute SHA-256 hex digest of a UTF-8 string. */
export function computeSha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/** Compute stable structural identity of a context unit independent of content and line numbers. */
export function computeUnitId(
  sourceId: ContextFileId,
  relativePath: string,
  headingPath: readonly string[],
  partIndex: number,
): string {
  return computeSha256(JSON.stringify([sourceId, relativePath, headingPath, partIndex]))
}

/** Compute content hash from normalized text. */
export function computeContentHash(content: string): string {
  return computeSha256(content)
}

/** Create a normalized context snapshot unit. */
export function createSnapshotUnit(options: {
  sourceId: ContextFileId
  relativePath: string
  headingPath: readonly string[]
  partIndex: number
  content: string
}): ContextSnapshotUnit {
  const normalizedContent = options.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const id = computeUnitId(options.sourceId, options.relativePath, options.headingPath, options.partIndex)
  const contentHash = computeContentHash(normalizedContent)

  return Object.freeze({
    id,
    sourceId: options.sourceId,
    relativePath: options.relativePath,
    headingPath: Object.freeze([...options.headingPath]),
    partIndex: options.partIndex,
    content: normalizedContent,
    contentHash,
  })
}

export interface PolicyRevisionOptions {
  mandatoryFiles: readonly (LoadedContextFile | { id: ContextFileId; content: string })[]
  missingFiles: readonly string[]
  contextRoot: string
  maxContextChars: number
  protocolVersion?: string
  includeFlags?: {
    includeAgents?: boolean
    includeProjectContext?: boolean
    includeCurrentState?: boolean
    includeDecisions?: boolean
    includeExperiments?: boolean
    includeHandoffRules?: boolean
  }
  budgets?: ContextBudgets
  contextMinRelativeScore?: number
}

/** Compute deterministic policy revision covering safety rules, protocol boundaries, and budgets. */
export function computePolicyRevision(options: PolicyRevisionOptions): string {
  const sortedMissing = [...options.missingFiles].sort()
  const policySignatures = [...options.mandatoryFiles]
    .filter(f => f.id === 'agents' || f.id === 'handoffRules')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(f => [f.id, computeContentHash(f.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))])

  const payload = JSON.stringify({
    protocolVersion: options.protocolVersion ?? 'dsh-context-delegation/v3',
    policySignatures,
    missingFiles: sortedMissing,
    contextRoot: options.contextRoot,
    maxContextChars: options.maxContextChars,
    includeFlags: options.includeFlags ?? {},
    budgets: options.budgets ?? {},
    contextMinRelativeScore: options.contextMinRelativeScore ?? 0.3,
  })

  return `sha256:${computeSha256(payload)}`
}

/** Build a canonical ContextSnapshot from a ContextBundle and policyRevision. */
export function buildContextSnapshot(options: {
  bundle: ContextBundle
  policyRevision: string
  maxSnapshotBytes?: number
}): ContextSnapshot {
  const { bundle, policyRevision, maxSnapshotBytes } = options
  const unitsMap = new Map<string, ContextSnapshotUnit>()

  // 1. Mandatory files
  const mandatory = bundle.selection?.mandatoryFiles ?? bundle.files.filter(f =>
    ['agents', 'currentState', 'handoffRules'].includes(f.id),
  )

  for (const file of mandatory) {
    const unit = createSnapshotUnit({
      sourceId: file.id,
      relativePath: file.relativePath,
      headingPath: [],
      partIndex: 0,
      content: file.content,
    })
    unitsMap.set(unit.id, unit)
  }

  // 2. Selected chunks
  const selectedChunks = bundle.selection?.selectedChunks ?? []
  // Group chunks by [sourceId, headingPath] and sort by startLine ascending to assign stable document partIndex
  const chunkGroups = new Map<string, ScoredContextChunk[]>()
  for (const chunk of selectedChunks) {
    const key = JSON.stringify([chunk.sourceId, chunk.relativePath, chunk.headingPath])
    let group = chunkGroups.get(key)
    if (!group) {
      group = []
      chunkGroups.set(key, group)
    }
    group.push(chunk)
  }

  for (const group of chunkGroups.values()) {
    // Sort document order by startLine ascending
    group.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0))
    group.forEach((chunk, fallbackIndex) => {
      const partIndex = chunk.partIndex ?? fallbackIndex
      const unit = createSnapshotUnit({
        sourceId: chunk.sourceId,
        relativePath: chunk.relativePath,
        headingPath: chunk.headingPath,
        partIndex,
        content: chunk.content,
      })
      unitsMap.set(unit.id, unit)
    })
  }

  // Sort units deterministically by unit id ascending
  const units = Object.freeze(
    Array.from(unitsMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
  )

  const missingFiles = Object.freeze(
    [...bundle.missingFiles].sort(),
  )

  const sourceLimitedFiles = Object.freeze(
    [...(bundle.selection?.sourceLimitedFiles ?? bundle.truncatedFiles ?? [])].sort(),
  )

  const revisionPayload = JSON.stringify({
    units: units.map(u => [u.id, u.contentHash]),
    missingFiles,
    sourceLimitedFiles,
    policyRevision,
  })

  const revision = `sha256:${computeSha256(revisionPayload)}`

  const snapshot: ContextSnapshot = Object.freeze({
    revision,
    policyRevision,
    units,
    missingFiles,
    sourceLimitedFiles,
  })

  if (maxSnapshotBytes !== undefined) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    if (serializedBytes > maxSnapshotBytes) {
      throw new ContextDelegationError(
        'SNAPSHOT_TOO_LARGE',
        `Serialized context snapshot size (${serializedBytes} bytes) exceeds limit (${maxSnapshotBytes} bytes).`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reduce context size or increase maxSnapshotBytes.',
        },
      )
    }
  }

  return snapshot
}
