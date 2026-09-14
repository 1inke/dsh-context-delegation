import { describe, expect, it } from 'vitest'
import { EXECUTOR_REPORT_FENCE, parseExecutorReport } from '../src/executor-report.ts'

function finalWithReport(report: unknown): string {
  return `Work done.\n\n\`\`\`json ${EXECUTOR_REPORT_FENCE}\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

describe('parseExecutorReport', () => {
  it('parses a well-formed executor report from the final message', () => {
    const report = {
      status: 'completed',
      summary: 'Added the widget.',
      filesChanged: ['src/widget.ts'],
      verification: [{ command: 'node test.js', outcome: 'passed', evidence: 'ok' }],
      risks: [],
    }
    const parsed = parseExecutorReport(finalWithReport(report))
    expect(parsed.status).toBe('completed')
    expect(parsed.summary).toBe('Added the widget.')
    expect(parsed.filesChanged).toEqual(['src/widget.ts'])
    expect(parsed.verification).toHaveLength(1)
    expect(parsed.verification[0]?.outcome).toBe('passed')
    expect(parsed.trustNotes).toEqual([])
  })

  it('uses the LAST executor-report fence when several exist', () => {
    const text = [
      finalWithReport({ status: 'completed', summary: 'first attempt', filesChanged: ['a.ts'], verification: [], risks: [] }),
      'Then I reconsidered.',
      finalWithReport({ status: 'failed', summary: 'second attempt', filesChanged: ['b.ts'], verification: [], risks: [] }),
    ].join('\n')
    const parsed = parseExecutorReport(text)
    expect(parsed.summary).toBe('second attempt')
    expect(parsed.filesChanged).toEqual(['b.ts'])
  })

  it('never invents success when the fence is missing', () => {
    const parsed = parseExecutorReport('I am done, everything passed!')
    expect(parsed.status).toBe('failed')
    expect(parsed.trustNotes?.length).toBeGreaterThan(0)
  })

  it('never invents success when the JSON is malformed', () => {
    const text = `\`\`\`json ${EXECUTOR_REPORT_FENCE}\n{ status: 'completed' not json }\n\`\`\``
    const parsed = parseExecutorReport(text)
    expect(parsed.status).toBe('failed')
    expect(parsed.trustNotes?.length).toBeGreaterThan(0)
  })

  it('coerces an unknown status to failed instead of trusting it', () => {
    const parsed = parseExecutorReport(finalWithReport({ status: 'totally-fine', summary: 'x' }))
    expect(parsed.status).toBe('failed')
    expect(parsed.trustNotes?.length).toBeGreaterThan(0)
  })

  it('coerces missing arrays to empty arrays and keeps string fields bounded', () => {
    const parsed = parseExecutorReport(finalWithReport({ status: 'completed' }))
    expect(parsed.status).toBe('completed')
    expect(parsed.filesChanged).toEqual([])
    expect(parsed.verification).toEqual([])
    expect(parsed.risks).toEqual([])
    expect(typeof parsed.summary).toBe('string')
  })
})
