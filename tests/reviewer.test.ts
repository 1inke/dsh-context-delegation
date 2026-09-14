import { describe, expect, it } from 'vitest'
import { buildReviewerPrompt, parseReviewReport, REVIEW_REPORT_FENCE } from '../src/reviewer.ts'

function fenced(report: unknown): string {
  return `Reviewed.\n\n\`\`\`json ${REVIEW_REPORT_FENCE}\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

describe('parseReviewReport', () => {
  it('parses a canonical labeled fence', () => {
    const parsed = parseReviewReport(fenced({ verdict: 'pass', reasons: ['ok'], unmetCriteria: [], suspiciousClaims: [] }))
    expect(parsed.verdict).toBe('pass')
    expect(parsed.trustNotes).toEqual([])
  })

  it('recovers a valid verdict from an unlabeled JSON fence', () => {
    const text = 'The evidence is consistent.\n\n```json\n{"verdict":"rework","reasons":["criterion 2 unmet"],"unmetCriteria":["C2"],"suspiciousClaims":[]}\n```\n'
    const parsed = parseReviewReport(text)
    expect(parsed.verdict).toBe('rework')
    expect(parsed.unmetCriteria).toEqual(['C2'])
    expect(parsed.trustNotes?.length).toBeGreaterThan(0)
  })

  it('recovers a valid verdict from bare trailing JSON', () => {
    const text = 'Analysis follows.\nSome prose mentioning "verdict" misleadingly: no.\n{"verdict":"pass","reasons":[],"unmetCriteria":[],"suspiciousClaims":[]}'
    const parsed = parseReviewReport(text)
    expect(parsed.verdict).toBe('pass')
    expect(parsed.trustNotes?.length).toBeGreaterThan(0)
  })

  it('never upgrades a message without a valid verdict to pass', () => {
    const parsed = parseReviewReport('Looks good to me, shipping it.')
    expect(parsed.verdict).toBe('blocked')
    expect(parsed.trustNotes?.length).toBeGreaterThan(0)
  })

  it('never upgrades an unknown verdict to pass', () => {
    const parsed = parseReviewReport(fenced({ verdict: 'definitely-fine', reasons: [] }))
    expect(parsed.verdict).toBe('blocked')
  })

  it('builds a prompt whose data payload is JSON-isolated from the envelope', () => {
    const prompt = buildReviewerPrompt({
      task: 'Do the thing',
      acceptanceCriteria: ['C1'],
      attempt: 1,
      maxAttempts: 2,
      context: { files: [{ relativePath: 'AGENTS.md' }], totalChars: 10, missingFiles: [] },
      executorReport: { status: 'completed', summary: 'x', filesChanged: [], verification: [], risks: [] },
      workspaceEvidence: { available: true, filesChanged: [] },
      verificationEvidence: [],
    })
    expect(prompt).toContain('---BEGIN DSH REVIEW INPUT JSON V1---')
    expect(prompt).toContain('dsh-review-report')
    const begin = prompt.indexOf('---BEGIN DSH REVIEW INPUT JSON V1---')
    const end = prompt.indexOf('---END DSH REVIEW INPUT JSON V1---')
    expect(() => JSON.parse(prompt.slice(begin + 36, end).trim())).not.toThrow()
  })
})
