import { describe, expect, it } from 'vitest'
import { chunkContext } from '../src/context-chunker.ts'

const source = { sourceId: 'decisions' as const, relativePath: 'harness/context/DECISIONS.md' }
const split = (content: string, maxChunkChars = 4000) =>
  chunkContext({ ...source, content }, { maxChunkChars, minChunkChars: 0 })

describe('V0.2 heading-aware chunker acceptance contract', () => {
  it('retains headings and separates siblings with their full ancestry', () => {
    const chunks = split('# AV2\nintro\n## Sampling\ncontent A\n### Non-uniform\ncontent B\n## Evaluation\ncontent C')
    expect(chunks.map(chunk => chunk.headingPath)).toEqual([
      ['AV2'], ['AV2', 'Sampling'], ['AV2', 'Sampling', 'Non-uniform'], ['AV2', 'Evaluation'],
    ])
    expect(chunks[1]!.content).toContain('## Sampling')
    expect(chunks[1]!.content).not.toContain('content B')
    expect(chunks[3]!.content).toContain('content C')
  })

  it('does not interpret fenced code headings as sections', () => {
    const chunks = split('# Policy\n```md\n## Not a section\n```\nTail')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toContain('## Not a section')
  })

  it('bounds oversized paragraphs without losing or splitting Unicode text', () => {
    const content = '# Large\n' + '😀'.repeat(250)
    const chunks = split(content, 80)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.content.length <= 80)).toBe(true)
    expect(chunks.map(chunk => chunk.content).join('')).toBe(content)
    for (const chunk of chunks) {
      expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    }
  })

  it('normalizes line endings and produces deterministic provenance', () => {
    const lf = split('# Topic\nbody\n## Child\nmore')
    expect(split('# Topic\r\nbody\r\n## Child\r\nmore')).toEqual(lf)
    expect(split('# Topic\nbody\n## Child\nmore')).toEqual(lf)
    expect(lf[1]!).toMatchObject({ ...source, startLine: 3, endLine: 4 })
  })

  it('preserves preamble and ignores headings inside tilde fences', () => {
    const chunks = split('preamble\n\n~~~markdown\n## Literal\n~~~\n## Real\nbody')
    expect(chunks.map(chunk => chunk.headingPath)).toEqual([[], ['Real']])
    expect(chunks[0]!.content).toContain('## Literal')
  })

  it('rejects invalid bounds', () => {
    expect(() => chunkContext({ ...source, content: 'x' }, { maxChunkChars: 1 })).toThrow(RangeError)
    expect(() => chunkContext({ ...source, content: 'x' }, { maxChunkChars: 4.5 })).toThrow(RangeError)
    expect(() => chunkContext({ ...source, content: 'x' }, { maxChunkChars: 4, minChunkChars: 5 })).toThrow(RangeError)
  })
  it('bounds metadata growth for adversarial tiny-section inputs', () => {
    expect(() => split('# x\n'.repeat(10001))).toThrow('chunk limit')
  })
  it('handles skipped heading levels as siblings and reports inclusive end lines', () => {
    const chunks = split('# Root\n### First\na\n### Second\nb\n')
    expect(chunks.map(c => c.headingPath)).toEqual([['Root'], ['Root', 'First'], ['Root', 'Second']])
    expect(chunks[0]!.endLine).toBe(1)
    expect(chunks[1]!.endLine).toBe(3)
  })
  it('does not close a fence with trailing non-whitespace text', () => {
    expect(split('# Root\n```\n```not-a-close\n# Literal\n```\n## Real\ntext')
      .map(c => c.headingPath)).toEqual([['Root'], ['Root', 'Real']])
  })
})
