import { describe, expect, it } from 'vitest'
import { buildContextQuery } from '../src/context-query.js'
import { rankContextChunks } from '../src/context-retrieval.js'
import type { ContextChunk } from '../src/types.js'

const chunk = (overrides: Partial<ContextChunk>): ContextChunk => ({ sourceId: 'agents', relativePath: 'docs/a.md', headingPath: ['Overview'], content: '', ...overrides })

describe('context chunk retrieval', () => {
  it('adds the documented heading, token and body contributions without word stuffing', () => {
    const query = buildContextQuery({ task: 'parser' })
    const result = rankContextChunks([
      chunk({ headingPath: ['Parser'], content: 'parser' }),
      chunk({ headingPath: ['Other'], content: 'parser '.repeat(100) }),
    ], query)
    expect(result[0]!.score).toBe(9)
    expect(result[1]!.score).toBe(1)
    expect(result[0]!.matchedTerms).toEqual(['parser'])
  })
  it('keeps nonzero ties stable when input chunks are reordered', () => {
    const query = buildContextQuery({ task: 'parser' })
    const sources = [chunk({ relativePath: 'b.md', content: 'parser' }), chunk({ relativePath: 'a.md', content: 'parser' })]
    expect(rankContextChunks(sources, query)).toEqual(rankContextChunks([...sources].reverse(), query))
  })
  it('does not boost a filename prefix inside a different path', () => {
    const query = { rawText: '', terms: [], relevantFiles: ['src/a.ts'] }
    expect(rankContextChunks([chunk({ content: 'src/a.tsx unrelated' })], query)[0]!.score).toBe(0)
  })
  it('scores heading, body, source path and explicit relevant file hits', () => {
    const query = buildContextQuery({ task: 'parser', relevant_files: ['src/parser.ts'] })
    const result = rankContextChunks([
      chunk({ relativePath: 'src/context.md', content: 'parser src/parser.ts' }),
      chunk({ relativePath: 'docs/z.md', headingPath: ['Parser'], content: '' }),
    ], query)
    expect(result[0]!.score).toBeGreaterThan(result[1]!.score)
    expect(result[0]!.matchedTerms).toContain('src/parser.ts')
  })

  it('returns zero-score chunks in stable lexical order', () => {
    const query = buildContextQuery({ task: 'missing' })
    const result = rankContextChunks([
      chunk({ relativePath: 'z.md', startLine: 1 }),
      chunk({ relativePath: 'a.md', startLine: 3 }),
    ], query)
    expect(result.map((item) => item.relativePath)).toEqual(['a.md', 'z.md'])
    expect(result.every((item) => item.score === 0)).toBe(true)
  })

  it('matches Chinese bigrams', () => {
    const query = buildContextQuery({ task: '中文采样' })
    const result = rankContextChunks([chunk({ content: '这里进行采样' })], query)
    expect(result[0]!.matchedTerms).toContain('采样')
  })
})
