import { describe, expect, it } from 'vitest'
import {
  buildContextSnapshot,
  computePolicyRevision,
  computeUnitId,
  createSnapshotUnit,
} from '../src/context-fingerprint.ts'
import type { ContextBundle, LoadedContextFile, ScoredContextChunk } from '../src/types.ts'

describe('context fingerprinting and snapshotting', () => {
  it('computes stable unit id independent of content and line numbers', () => {
    const id1 = computeUnitId('projectContext', 'harness/context/PROJECT_CONTEXT.md', ['Architecture', 'Overview'], 0)
    const id2 = computeUnitId('projectContext', 'harness/context/PROJECT_CONTEXT.md', ['Architecture', 'Overview'], 0)
    const idDiffPart = computeUnitId('projectContext', 'harness/context/PROJECT_CONTEXT.md', ['Architecture', 'Overview'], 1)
    const idDiffHeading = computeUnitId('projectContext', 'harness/context/PROJECT_CONTEXT.md', ['Architecture', 'Details'], 0)

    expect(id1).toBe(id2)
    expect(id1).not.toBe(idDiffPart)
    expect(id1).not.toBe(idDiffHeading)
    expect(typeof id1).toBe('string')
    expect(id1).toHaveLength(64)
  })

  it('normalizes CRLF to LF in snapshot units and preserves exact other whitespace', () => {
    const unitCRLF = createSnapshotUnit({
      sourceId: 'currentState',
      relativePath: 'harness/context/CURRENT_STATE.md',
      headingPath: [],
      partIndex: 0,
      content: 'Line 1\r\n  Indented Line 2\r\n',
    })
    const unitLF = createSnapshotUnit({
      sourceId: 'currentState',
      relativePath: 'harness/context/CURRENT_STATE.md',
      headingPath: [],
      partIndex: 0,
      content: 'Line 1\n  Indented Line 2\n',
    })

    expect(unitCRLF.content).toBe('Line 1\n  Indented Line 2\n')
    expect(unitCRLF.contentHash).toBe(unitLF.contentHash)
    expect(unitCRLF.id).toBe(unitLF.id)
    expect(unitCRLF.content).toContain('  Indented Line 2')
  })

  it('keeps unit identity stable when content changes while contentHash updates', () => {
    const unitV1 = createSnapshotUnit({
      sourceId: 'projectContext',
      relativePath: 'harness/context/PROJECT_CONTEXT.md',
      headingPath: ['Module A'],
      partIndex: 0,
      content: 'Initial content',
    })
    const unitV2 = createSnapshotUnit({
      sourceId: 'projectContext',
      relativePath: 'harness/context/PROJECT_CONTEXT.md',
      headingPath: ['Module A'],
      partIndex: 0,
      content: 'Modified content with different lines',
    })

    expect(unitV1.id).toBe(unitV2.id)
    expect(unitV1.contentHash).not.toBe(unitV2.contentHash)
  })

  it('distinguishes duplicate headings across different files and different ordinal parts', () => {
    const unitFileA = createSnapshotUnit({
      sourceId: 'projectContext',
      relativePath: 'doc-a.md',
      headingPath: ['Introduction'],
      partIndex: 0,
      content: 'Text A',
    })
    const unitFileB = createSnapshotUnit({
      sourceId: 'projectContext',
      relativePath: 'doc-b.md',
      headingPath: ['Introduction'],
      partIndex: 0,
      content: 'Text B',
    })
    const unitPart1 = createSnapshotUnit({
      sourceId: 'projectContext',
      relativePath: 'doc-a.md',
      headingPath: ['Introduction'],
      partIndex: 1,
      content: 'Text A continuation',
    })

    expect(unitFileA.id).not.toBe(unitFileB.id)
    expect(unitFileA.id).not.toBe(unitPart1.id)
  })

  it('builds canonical ContextSnapshot with deterministic unit ordering and revision', () => {
    const mandatoryFiles: LoadedContextFile[] = [
      {
        id: 'agents',
        relativePath: 'AGENTS.md',
        content: '# Agents rules\r\nrule 1\r\n',
        originalChars: 22,
        includedChars: 22,
        truncated: false,
      },
      {
        id: 'currentState',
        relativePath: 'harness/context/CURRENT_STATE.md',
        content: '# Current state\nactive\n',
        originalChars: 23,
        includedChars: 23,
        truncated: false,
      },
    ]

    const selectedChunks: ScoredContextChunk[] = [
      {
        sourceId: 'projectContext',
        relativePath: 'harness/context/PROJECT_CONTEXT.md',
        headingPath: ['System', 'Architecture'],
        startLine: 10,
        endLine: 20,
        content: 'Chunk 2 content',
        score: 5,
        matchedTerms: ['Architecture'],
      },
      {
        sourceId: 'projectContext',
        relativePath: 'harness/context/PROJECT_CONTEXT.md',
        headingPath: ['System', 'Overview'],
        startLine: 1,
        endLine: 9,
        content: 'Chunk 1 content',
        score: 8,
        matchedTerms: ['Overview'],
      },
    ]

    const bundle: ContextBundle = {
      workspaceRoot: 'C:/mock/workspace',
      files: [],
      missingFiles: ['DECISIONS.md'],
      truncatedFiles: [],
      totalChars: 100,
      selection: {
        minimumScore: 0.3,
        mandatoryFiles,
        selectedChunks,
        rejectedChunks: [],
        totalChars: 100,
        budgetUsage: { mandatory: 45, project: 55, decisions: 0, experiments: 0 },
        budgets: {
          mandatory: 14000,
          project: 8000,
          decisions: 8000,
          experiments: 8000,
        },
        sourceLimitedFiles: [],
      },
    }

    const policyRevision = computePolicyRevision({
      mandatoryFiles,
      missingFiles: bundle.missingFiles,
      contextRoot: 'harness/context',
      maxContextChars: 40000,
    })

    const snapshot = buildContextSnapshot({
      bundle,
      policyRevision,
      maxSnapshotBytes: 1024 * 1024,
    })

    expect(snapshot.revision.startsWith('sha256:')).toBe(true)
    expect(snapshot.policyRevision).toBe(policyRevision)
    expect(snapshot.missingFiles).toEqual(['DECISIONS.md'])
    expect(snapshot.units.length).toBe(4) // 2 mandatory + 2 selected chunks

    // Units are sorted by id ascending
    const ids = snapshot.units.map(u => u.id)
    const sortedIds = [...ids].sort((a, b) => a.localeCompare(b))
    expect(ids).toEqual(sortedIds)

    // Re-computing with shuffled selectedChunks produces identical revision
    const shuffledBundle: ContextBundle = {
      ...bundle,
      selection: {
        ...bundle.selection!,
        selectedChunks: [selectedChunks[1]!, selectedChunks[0]!],
      },
    }
    const snapshotReordered = buildContextSnapshot({
      bundle: shuffledBundle,
      policyRevision,
      maxSnapshotBytes: 1024 * 1024,
    })
    expect(snapshotReordered.revision).toBe(snapshot.revision)
  })

  it('fails with SNAPSHOT_TOO_LARGE when snapshot serialization exceeds maxSnapshotBytes', () => {
    const mandatoryFiles: LoadedContextFile[] = [
      {
        id: 'agents',
        relativePath: 'AGENTS.md',
        content: 'A'.repeat(500),
        originalChars: 500,
        includedChars: 500,
        truncated: false,
      },
    ]

    const bundle: ContextBundle = {
      workspaceRoot: 'C:/mock/workspace',
      files: [],
      missingFiles: [],
      truncatedFiles: [],
      totalChars: 500,
      selection: {
        minimumScore: 0.3,
        mandatoryFiles,
        selectedChunks: [],
        rejectedChunks: [],
        totalChars: 500,
        budgetUsage: { mandatory: 500, project: 0, decisions: 0, experiments: 0 },
        budgets: {
          mandatory: 14000,
          project: 8000,
          decisions: 8000,
          experiments: 8000,
        },
        sourceLimitedFiles: [],
      },
    }

    const policyRevision = 'sha256:mockpolicy'

    expect(() => buildContextSnapshot({
      bundle,
      policyRevision,
      maxSnapshotBytes: 100, // Very small limit to trigger failure
    })).toThrowError(/SNAPSHOT_TOO_LARGE/)
  })
})
