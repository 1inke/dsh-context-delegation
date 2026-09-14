import { describe, expect, it } from 'vitest'
import { budgetContextFiles, normalizeContextText } from '../src/context-budget.ts'
import { ContextDelegationError } from '../src/errors.ts'
import { DEFAULT_TRUNCATION_NOTICE, type ContextCandidate } from '../src/types.ts'

describe('W2-2 normalizeContextText', () => {
  it('normalizes CRLF, CR, and mixed line endings to LF', () => {
    expect(normalizeContextText('line1\r\nline2\r\n')).toBe('line1\nline2\n')
    expect(normalizeContextText('line1\rline2\r')).toBe('line1\nline2\n')
    expect(normalizeContextText('line1\r\nline2\rline3\n')).toBe('line1\nline2\nline3\n')
    expect(normalizeContextText('')).toBe('')
  })
})

describe('W2-2 budgetContextFiles', () => {
  it('budgets candidates within limits without truncation', () => {
    const candidates: ContextCandidate[] = [
      { id: 'agents', relativePath: 'AGENTS.md', priority: 1, content: 'Agents 123' },
      { id: 'currentState', relativePath: 'CURRENT_STATE.md', priority: 2, content: 'State 456' },
    ]
    const result = budgetContextFiles(candidates, { maxContextChars: 1000 })

    expect(result.files.length).toBe(2)
    expect(result.truncatedFiles).toEqual([])
    expect(result.totalChars).toBe('Agents 123'.length + 'State 456'.length)
    expect(result.files[0]!.truncated).toBe(false)
    expect(result.files[1]!.truncated).toBe(false)
  })

  it('normalizes candidate line endings inside the public budgeting boundary', () => {
    const result = budgetContextFiles([
      { id: 'agents', relativePath: 'AGENTS.md', priority: 1, content: '\r\nx' },
    ], { maxContextChars: 2 })

    expect(result.files[0]!.content).toBe('\nx')
    expect(result.files[0]!.originalChars).toBe(2)
    expect(result.totalChars).toBe(2)
  })

  it('truncates a bounded prefix without claiming an exact original length', () => {
    const result = budgetContextFiles([
      {
        id: 'currentState',
        relativePath: 'CURRENT_STATE.md',
        priority: 2,
        content: 'x'.repeat(201),
        sourceComplete: false,
      },
    ], { maxContextChars: 200 })

    expect(result.files[0]!.truncated).toBe(true)
    expect(result.files[0]!.originalChars).toBeNull()
    expect(result.totalChars).toBe(200)
  })

  it('rejects unsafe direct-call budgets above the operational hard limit', () => {
    expect(() => budgetContextFiles([], { maxContextChars: 1_000_001 })).toThrow(
      '[PLUGIN_INTERNAL_ERROR]',
    )
  })

  it('internally sorts candidates by priority ascending even if input is unordered', () => {
    const candidates: ContextCandidate[] = [
      { id: 'projectContext', relativePath: 'PROJECT_CONTEXT.md', priority: 3, content: 'Project' },
      { id: 'agents', relativePath: 'AGENTS.md', priority: 1, content: 'Agents' },
      { id: 'currentState', relativePath: 'CURRENT_STATE.md', priority: 2, content: 'State' },
    ]
    const result = budgetContextFiles(candidates, { maxContextChars: 1000 })

    expect(result.files.map(f => f.id)).toEqual(['agents', 'currentState', 'projectContext'])
    expect(result.files.map(f => f.relativePath)).toEqual([
      'AGENTS.md',
      'CURRENT_STATE.md',
      'PROJECT_CONTEXT.md',
    ])
  })

  it('throws CONTEXT_TOO_LARGE if Priority 1 exceeds maxContextChars', () => {
    const candidates: ContextCandidate[] = [
      {
        id: 'agents',
        relativePath: 'AGENTS.md',
        priority: 1,
        content: 'A'.repeat(500),
      },
    ]

    expect(() => budgetContextFiles(candidates, { maxContextChars: 400 })).toThrow(
      ContextDelegationError,
    )
    try {
      budgetContextFiles(candidates, { maxContextChars: 400 })
    } catch (err: any) {
      expect(err.code).toBe('CONTEXT_TOO_LARGE')
      expect(err.details.layer).toBe('context')
      expect(err.details.codexInvoked).toBe(false)
      expect(err.details.workspaceMayHaveChanged).toBe(false)
      expect(err.details.nextAction).toContain('AGENTS.md')
    }
  })

  it('truncates Priority 2-6 and strictly includes notice length in budget', () => {
    const agentsText = 'Agents Rules' // 12 chars
    const stateText = 'X'.repeat(500)
    const maxChars = 12 + DEFAULT_TRUNCATION_NOTICE.length + 50 // 12 + 72 + 50 = 134

    const candidates: ContextCandidate[] = [
      { id: 'agents', relativePath: 'AGENTS.md', priority: 1, content: agentsText },
      { id: 'currentState', relativePath: 'CURRENT_STATE.md', priority: 2, content: stateText },
    ]

    const result = budgetContextFiles(candidates, { maxContextChars: maxChars })

    expect(result.files[0]!.truncated).toBe(false)
    expect(result.files[0]!.includedChars).toBe(12)

    expect(result.files[1]!.truncated).toBe(true)
    expect(result.files[1]!.content.endsWith(DEFAULT_TRUNCATION_NOTICE)).toBe(true)
    expect(result.truncatedFiles).toEqual(['CURRENT_STATE.md'])

    // Invariant: totalChars <= maxChars
    expect(result.totalChars).toBeLessThanOrEqual(maxChars)
    expect(result.totalChars).toBe(maxChars)
  })

  it('protects UTF-16 surrogate pairs from split at truncation point', () => {
    // Emoji: 😀 is 2 code units: \uD83D\uDE00
    const prefix = 'A'.repeat(30)
    const emoji = '😀'
    const fullContent = prefix + emoji + 'B'.repeat(100)

    // Set budget so that cut point lands directly between high and low surrogate
    // remaining = prefix.length (30) + 1 (high surrogate) + notice.length
    const maxChars = 30 + 1 + DEFAULT_TRUNCATION_NOTICE.length

    const candidates: ContextCandidate[] = [
      { id: 'currentState', relativePath: 'CURRENT_STATE.md', priority: 2, content: fullContent },
    ]

    const result = budgetContextFiles(candidates, { maxContextChars: maxChars })
    const truncated = result.files[0]!.content
    expect(result.files[0]!.truncated).toBe(true)

    // The cut should back off by 1 so high surrogate is not isolated
    expect(truncated.startsWith(prefix + DEFAULT_TRUNCATION_NOTICE)).toBe(true)
    expect(truncated.includes('\uD83D')).toBe(false)
    expect(result.totalChars).toBeLessThanOrEqual(maxChars)
  })

  it('completely omits content when remaining budget is less than notice + 30 chars', () => {
    const candidates: ContextCandidate[] = [
      { id: 'agents', relativePath: 'AGENTS.md', priority: 1, content: 'A'.repeat(95) },
      { id: 'currentState', relativePath: 'CURRENT_STATE.md', priority: 2, content: 'B'.repeat(100) },
    ]

    // maxContextChars = 100. Agents takes 95, remaining = 5 < notice.length + 30
    const result = budgetContextFiles(candidates, { maxContextChars: 100 })

    expect(result.files[0]!.includedChars).toBe(95)
    expect(result.files[0]!.truncated).toBe(false)

    expect(result.files[1]!.includedChars).toBe(0)
    expect(result.files[1]!.content).toBe('')
    expect(result.files[1]!.truncated).toBe(true)
    expect(result.truncatedFiles).toEqual(['CURRENT_STATE.md'])
    expect(result.totalChars).toBe(95)
  })
})
