import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ContextDelegationService } from '../src/index.ts'
import { renderCodexExpertResult } from '../src/result.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationInput, DelegationResult, ExecutorReport, ReviewReport } from '../src/types.ts'

const exec = promisify(execFile)

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function createReviewRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v04-loop-'))
  dirs.push(root)
  await exec('git', ['init', '-b', 'main'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.test'], { cwd: root })
  await exec('git', ['config', 'user.name', 'test'], { cwd: root })
  await mkdirs(root, ['harness/context'])
  await writeFile(join(root, 'harness/context/AGENTS.md'), '# Agents\n\nBe safe and honest.\n')
  await writeFile(join(root, 'harness/context/CURRENT_STATE.md'), '# Current State\n\nBaseline.\n')
  await writeFile(join(root, 'harness/context/CODEX_HANDOFF.md'), '# Handoff Rules\n\nReport honestly.\n')
  await writeFile(join(root, 'widget.ts'), 'export const color = "blue"\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-m', 'baseline'], { cwd: root })
  return root
}

async function mkdirs(root: string, paths: string[]): Promise<void> {
  for (const path of paths) await mkdirRecursive(join(root, path))
}

async function mkdirRecursive(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

function executorFinal(report: Partial<ExecutorReport> & { status: ExecutorReport['status'] }): string {
  return `Work done.\n\n\`\`\`json dsh-executor-report\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

function reviewerFinal(report: Partial<ReviewReport> & { verdict: ReviewReport['verdict'] }): string {
  return `Reviewed.\n\n\`\`\`json dsh-review-report\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

function createReviewEnvironment(root: string, maxReviewRounds = 1) {
  const ctx = new Context()
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
  const providers: Record<string, unknown> = {
    codex: { name: 'codex', capabilities: {} },
    reviewer: { name: 'reviewer', capabilities: {} },
  }
  const startCalls: { provider: string; label: string; prompt: string }[] = []
  let executorOutputs: string[] = []
  let reviewerOutputs: string[] = []
  const subagents = {
    getProvider: (name: string) => providers[name],
    start: vi.fn(async (provider: string, request: { label: string; prompt: { type: string; text: string }[] }) => {
      const prompt = request.prompt.map(block => block.text).join('')
      startCalls.push({ provider, label: request.label, prompt })
      const text = provider === 'reviewer' ? reviewerOutputs.shift() : executorOutputs.shift()
      if (text === undefined) throw new Error(`unexpected start call for provider "${provider}" (scripted output exhausted)`)
      return {
        id: `run-${startCalls.length}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
        dispose: vi.fn(),
      }
    }),
  }
  ;(ctx as any).subagents = subagents
  const service = new ContextDelegationService(ctx, {
    providerName: 'codex',
    reviewProviderName: 'reviewer',
    maxReviewRounds,
  })
  return {
    ctx,
    service,
    startCalls,
    scriptExecutor: (outputs: string[]) => { executorOutputs = [...outputs] },
    scriptReviewer: (outputs: string[]) => { reviewerOutputs = [...outputs] },
  }
}

function makeExec(root: string): { parent: Agent; signal: AbortSignal } {
  const parent = { id: 'parent-1', session: { id: 'parent-1', header: { cwd: root } } } as unknown as Agent
  return { parent, signal: new AbortController().signal }
}

const BASE_INPUT: DelegationInput = {
  task: 'Change the widget color to red.',
  acceptance_criteria: ['C1: widget.ts declares color red'],
}

describe('review loop (mock executor/reviewer, real git evidence and real verification)', () => {
  it('RED 1: surfaces actual workspace changes that the executor denied', async () => {
    const root = await createReviewRepo()
    await writeFile(join(root, 'widget.ts'), 'export const color = "red"\n')
    await writeFile(join(root, 'new-evidence.txt'), 'created\n')
    const env = createReviewEnvironment(root)
    env.scriptExecutor([executorFinal({ status: 'completed', summary: 'I changed nothing.', filesChanged: [], verification: [], risks: [] })])
    env.scriptReviewer([reviewerFinal({ verdict: 'pass', reasons: ['evidence consistent'] })])

    const result = await env.service.delegate(BASE_INPUT, makeExec(root)) as DelegationResult

    expect(result.review).toBeDefined()
    expect(result.review!.workspaceEvidence.available).toBe(true)
    expect(result.review!.workspaceEvidence.filesChanged).toContain('widget.ts')
    expect(result.review!.workspaceEvidence.filesChanged).toContain('new-evidence.txt')
    const reviewerCall = env.startCalls.find(call => call.provider === 'reviewer')!
    expect(reviewerCall).toBeDefined()
    expect(reviewerCall.prompt).toContain('widget.ts')
    expect(result.review!.outcome).toBe('completed')
  })

  it('RED 2: an executor verification claim that independently fails can never end as pass', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root)
    env.scriptExecutor([
      executorFinal({
        status: 'completed',
        summary: 'All tests passed.',
        filesChanged: ['widget.ts'],
        verification: [{ command: 'node -e "process.exit(2)"', outcome: 'passed', evidence: 'trust me' }],
        risks: [],
      }),
      executorFinal({ status: 'completed', summary: 'Second attempt.', filesChanged: ['widget.ts'], verification: [], risks: [] }),
    ])
    env.scriptReviewer([
      reviewerFinal({ verdict: 'rework', reasons: ['independent verification failed'], unmetCriteria: ['C1'] }),
      reviewerFinal({ verdict: 'rework', reasons: ['still failing'], unmetCriteria: ['C1'] }),
    ])

    const result = await env.service.delegate({
      ...BASE_INPUT,
      verification_commands: ['node -e "process.exit(2)"'],
    }, makeExec(root)) as DelegationResult

    expect(result.review!.verification[0]?.outcome).toBe('failed')
    expect(result.review!.verification[0]?.exitCode).toBe(2)
    const firstReviewerCall = env.startCalls.filter(call => call.provider === 'reviewer')[0]!
    expect(firstReviewerCall.prompt).toContain('"failed"')
    expect(firstReviewerCall.prompt).toContain('process.exit(2)')
    expect(result.review!.outcome).not.toBe('completed')
    expect(result.review!.outcome).toBe('rework')
  })

  it('RED 3: unmet criteria produce one bounded rework with the reasons embedded', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root, 1)
    env.scriptExecutor([
      executorFinal({ status: 'completed', summary: 'Partial work.', filesChanged: ['widget.ts'], verification: [], risks: [] }),
      executorFinal({ status: 'completed', summary: 'Completed after rework.', filesChanged: ['widget.ts'], verification: [], risks: [] }),
    ])
    env.scriptReviewer([
      reviewerFinal({ verdict: 'rework', reasons: ['criterion C2 not addressed'], unmetCriteria: ['C2: tests added'] }),
      reviewerFinal({ verdict: 'pass', reasons: ['all criteria met'] }),
    ])

    const result = await env.service.delegate({
      ...BASE_INPUT,
      acceptance_criteria: ['C1: widget.ts declares color red', 'C2: tests added'],
    }, makeExec(root)) as DelegationResult

    expect(result.review!.executorAttempts).toBe(2)
    expect(result.review!.rounds).toBe(2)
    expect(result.review!.outcome).toBe('completed')
    const secondExecutorPrompt = env.startCalls.filter(call => call.provider === 'codex')[1]!.prompt
    expect(secondExecutorPrompt).toContain('C2: tests added')
    expect(secondExecutorPrompt).toContain('criterion C2 not addressed')
  })

  it('RED 4: an executor blocked report stops the loop and is never presented as success', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root)
    env.scriptExecutor([executorFinal({ status: 'blocked', summary: 'test infrastructure is missing', filesChanged: [], verification: [], risks: [] })])

    const result = await env.service.delegate(BASE_INPUT, makeExec(root)) as DelegationResult

    expect(result.review!.outcome).toBe('blocked')
    expect(env.startCalls).toHaveLength(1)
    const rendered = renderCodexExpertResult(result)
    expect(rendered).toContain('Status: BLOCKED')
    expect(rendered).not.toContain('Status: success')
  })

  it('RED 5: commands the caller never authorized are never executed', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root)
    env.scriptExecutor([
      executorFinal({
        status: 'completed',
        summary: 'Ran my own checks.',
        filesChanged: ['widget.ts'],
        verification: [
          { command: 'node -e "require(\'fs\').writeFileSync(\'authorized-marker.txt\',\'ok\')"', outcome: 'passed', evidence: 'ok' },
          { command: 'node -e "require(\'fs\').writeFileSync(\'unauthorized-marker.txt\',\'ran\')"', outcome: 'passed', evidence: 'ok' },
        ],
        risks: [],
      }),
    ])
    env.scriptReviewer([reviewerFinal({ verdict: 'pass', reasons: ['claims match evidence'] })])

    const result = await env.service.delegate({
      ...BASE_INPUT,
      verification_commands: ['node -e "require(\'fs\').writeFileSync(\'authorized-marker.txt\',\'ok\')"'],
    }, makeExec(root)) as DelegationResult

    await expect(readFile(join(root, 'authorized-marker.txt'), 'utf8')).resolves.toBe('ok')
    await expect(readFile(join(root, 'unauthorized-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const reviewerCall = env.startCalls.find(call => call.provider === 'reviewer')!
    expect(reviewerCall.prompt).toContain('unauthorized-marker.txt')
    expect(result.review!.outcome).toBe('completed')
  })

  it('RED 6: the rework loop stops hard at maxReviewRounds', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root, 1)
    env.scriptExecutor([
      executorFinal({ status: 'completed', summary: 'Attempt 1.', filesChanged: [], verification: [], risks: [] }),
      executorFinal({ status: 'completed', summary: 'Attempt 2.', filesChanged: [], verification: [], risks: [] }),
    ])
    env.scriptReviewer([
      reviewerFinal({ verdict: 'rework', reasons: ['not good enough'], unmetCriteria: ['C1'] }),
      reviewerFinal({ verdict: 'rework', reasons: ['still not good enough'], unmetCriteria: ['C1'] }),
    ])

    const result = await env.service.delegate(BASE_INPUT, makeExec(root)) as DelegationResult

    expect(result.review!.executorAttempts).toBe(2)
    expect(result.review!.rounds).toBe(2)
    expect(result.review!.outcome).toBe('rework')
    expect(result.review!.reworkLimitReached).toBe(true)
    expect(env.startCalls).toHaveLength(4)
    const rendered = renderCodexExpertResult(result)
    expect(rendered).toContain('Status: REWORK')
    expect(rendered).toContain('rework limit')
  })

  it('rejects acceptance criteria on continuation mode instead of silently skipping review', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root)
    env.scriptExecutor([executorFinal({ status: 'completed', summary: 'x', filesChanged: [], verification: [], risks: [] })])

    await expect(env.service.delegate({
      task: 't',
      mode: 'continue',
      delegation_key: 'review-key-1',
      acceptance_criteria: ['C1'],
    }, makeExec(root))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(env.startCalls).toHaveLength(0)
  })

  it('renders a passing review without claiming the parent no longer verifies', async () => {
    const root = await createReviewRepo()
    const env = createReviewEnvironment(root)
    env.scriptExecutor([executorFinal({ status: 'completed', summary: 'Done.', filesChanged: ['widget.ts'], verification: [], risks: [] })])
    env.scriptReviewer([reviewerFinal({ verdict: 'pass', reasons: ['evidence consistent'] })])

    const result = await env.service.delegate(BASE_INPUT, makeExec(root)) as DelegationResult
    const rendered = renderCodexExpertResult(result)
    expect(rendered).toContain('Status: success')
    expect(rendered).toContain('Reviewer verdict (round 1): pass')
    expect(rendered).toContain('independently verify')
  })

  it('forbids parent VERIFIED when review outcome is rework or blocked', async () => {
    const root = await createReviewRepo()
    const envRework = createReviewEnvironment(root, 0)
    envRework.scriptExecutor([executorFinal({ status: 'completed', summary: 'Did it.', filesChanged: [], verification: [], risks: [] })])
    envRework.scriptReviewer([reviewerFinal({ verdict: 'rework', reasons: ['broken logic'], unmetCriteria: ['C1'] })])

    const reworkResult = await envRework.service.delegate(BASE_INPUT, makeExec(root)) as DelegationResult
    const reworkRendered = renderCodexExpertResult(reworkResult)
    expect(reworkRendered).toContain('Status: REWORK')
    expect(reworkRendered).toContain('CRITICAL REVIEW OUTCOME: REWORK REQUIRED')
    expect(reworkRendered).toContain('MUST NOT output [STATUS: VERIFIED]')
    expect(reworkRendered).toContain('CRITICAL: The independent reviewer outcome is REWORK. Do NOT output [STATUS: VERIFIED]')

    const envBlocked = createReviewEnvironment(root, 0)
    envBlocked.scriptExecutor([executorFinal({ status: 'blocked', summary: 'No access.', filesChanged: [], verification: [], risks: [] })])

    const blockedResult = await envBlocked.service.delegate(BASE_INPUT, makeExec(root)) as DelegationResult
    const blockedRendered = renderCodexExpertResult(blockedResult)
    expect(blockedRendered).toContain('Status: BLOCKED')
    expect(blockedRendered).toContain('CRITICAL REVIEW OUTCOME: BLOCKED')
    expect(blockedRendered).toContain('MUST NOT declare [STATUS: VERIFIED]')
    expect(blockedRendered).toContain('CRITICAL: The independent reviewer outcome is BLOCKED. Do NOT output [STATUS: VERIFIED]')
  })
})
