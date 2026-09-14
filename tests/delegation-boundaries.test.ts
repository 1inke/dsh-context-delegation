import { describe, expect, it } from 'vitest'
import {
  buildCodexHandoff,
  boundedProviderDiagnostic,
  describeAbnormalResult,
  HANDOFF_PAYLOAD_BEGIN,
  HANDOFF_PAYLOAD_END,
  MAX_FAILURE_PARTIAL_CHARS,
  MAX_PROVIDER_DIAGNOSTIC_BYTES,
  textFromContentBlocks,
} from '../src/index.ts'
import type { ContextBundle } from '../src/types.ts'

const context: ContextBundle = {
  workspaceRoot: 'C:\\workspace\\project',
  files: [
    { id: 'agents', relativePath: 'AGENTS.md', content: 'rules', originalChars: 5, includedChars: 5, truncated: false },
  ],
  missingFiles: [],
  truncatedFiles: [],
  totalChars: 5,
}

function abnormal(output: string, diagnostic?: string) {
  return { output: [{ type: 'text', text: output }], stopReason: 'error', ...(diagnostic === undefined ? {} : { diagnostic }) } as never
}

describe('Block 3 delegation boundaries', () => {
  it('keeps a diagnostic at exactly 4096 UTF-8 bytes unchanged', () => {
    const value = '界'.repeat(1365) + 'a'
    expect(Buffer.byteLength(value, 'utf8')).toBe(MAX_PROVIDER_DIAGNOSTIC_BYTES)
    expect(boundedProviderDiagnostic(value)).toBe(value)
  })

  it('truncates multibyte diagnostics without replacement characters or byte overflow', () => {
    const value = '界'.repeat(2000)
    const bounded = boundedProviderDiagnostic(value)!
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(MAX_PROVIDER_DIAGNOSTIC_BYTES)
    expect(bounded).not.toContain('\uFFFD')
    expect(boundedProviderDiagnostic(bounded)).toBe(bounded)
  })

  it('bounds partial output to 8000 UTF-16 units without cutting a surrogate pair', () => {
    const value = 'a'.repeat(7999) + '😀' + 'tail'
    const rendered = describeAbnormalResult(abnormal(value))
    const partial = rendered.split('Partial Codex output:\n')[1]!
    expect(partial.length).toBeLessThanOrEqual(MAX_FAILURE_PARTIAL_CHARS)
    expect(() => encodeURIComponent(partial)).not.toThrow()
    expect(partial).toContain('[... partial output truncated ...]')
  })

  it('concatenates only text blocks and excludes reasoning/tool payloads', () => {
    const blocks = [
      { type: 'text', text: 'visible-' },
      { type: 'reasoning', text: 'secret reasoning' },
      { type: 'tool-call', name: 'shell', arguments: { command: 'cat secret' } },
      { type: 'text', text: 'final' },
    ] as never
    expect(textFromContentBlocks(blocks)).toBe('visible-final')
  })

  it('serializes handoff data in exact section order without structural injection', () => {
    const task = 'line\r\n' + HANDOFF_PAYLOAD_BEGIN + '\u2028\u2029'
    const prompt = buildCodexHandoff({
      input: { task, acceptance_criteria: ['ok'], verification_commands: ['pnpm test'], notes: 'x\n' + HANDOFF_PAYLOAD_END },
      context: { ...context, workspaceRoot: 'C:\\workspace\\project', files: [{ id: 'agents', relativePath: 'AGENTS.md', content: 'a\r\nb', originalChars: 4, includedChars: 4, truncated: false }] },
      relevantFiles: ['src\\main.ts', 'README.md'],
    })
    const begin = prompt.indexOf(HANDOFF_PAYLOAD_BEGIN)
    const end = prompt.lastIndexOf(HANDOFF_PAYLOAD_END)
    const payload = JSON.parse(prompt.slice(begin + HANDOFF_PAYLOAD_BEGIN.length, end).trim()) as { sections: Array<{ name: string; value: unknown }> }
    expect(payload.sections.map(section => section.name)).toEqual([
      'Repository', 'Persistent Project Rules', 'Project Context', 'Current State',
      'Relevant Decisions', 'Relevant Experiment Evidence', 'Delegation Rules', 'Task',
      'Relevant Files', 'Acceptance Criteria', 'Verification Commands', 'Additional Notes', 'Required Return',
    ])
    expect((payload.sections[0]!.value as { workspaceRoot: string }).workspaceRoot).toBe('C:\\workspace\\project')
    expect(payload.sections[7]!.value).toBe(task)
    expect(payload.sections[8]!.value).toEqual(['src\\main.ts', 'README.md'])
    expect(payload.sections[12]!.value).toEqual([
      'Root cause or reasoning summary.', 'Files changed.', 'Exact functional changes made.',
      'Tests and verification commands run, including outcomes.', 'Remaining risks or blockers.',
      expect.stringContaining('dsh-executor-report'),
    ])
    expect(prompt.split('\n').filter(line => line === HANDOFF_PAYLOAD_BEGIN || line === HANDOFF_PAYLOAD_END)).toHaveLength(2)
  })
})
