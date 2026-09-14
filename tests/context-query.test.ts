import { describe, expect, it } from 'vitest'
import { buildContextQuery, tokenizeContext } from '../src/context-query.js'

describe('context query construction', () => {
  it('does not split a surrogate pair when bounding query text', () => {
    const query = buildContextQuery({ task: 'x'.repeat(15999) + '😀' })
    expect(query.rawText).toBe('x'.repeat(15999))
  })
  it('uses task, files, acceptance criteria and notes but excludes verification commands', () => {
    const query = buildContextQuery({ task: 'Fix parser', relevant_files: ['src/parser.ts'], acceptance_criteria: ['tests pass'], verification_commands: ['secret command'], notes: 'keep API' })
    expect(query.rawText).toContain('Fix parser')
    expect(query.rawText).toContain('src/parser.ts')
    expect(query.rawText).toContain('tests pass')
    expect(query.rawText).toContain('keep API')
    expect(query.rawText).not.toContain('secret command')
  })

  it('deduplicates stopwords and preserves identifier components and Chinese bigrams', () => {
    const tokens = tokenizeContext('BuildContextQuery build_context-query 中文采样')
    expect(tokens).toEqual(expect.arrayContaining(['buildcontextquery', 'build', 'context', 'query', '中文', '采样']))
    expect(tokens).not.toContain('the')
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('caps terms deterministically', () => {
    const query = buildContextQuery({ task: Array.from({ length: 200 }, (_, i) => `term${i}`).join(' ') })
    expect(query.terms).toHaveLength(128)
  })
})
