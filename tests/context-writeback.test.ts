import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ContextDelegationService } from '../src/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationInput, DelegationResult, ExecutorReport } from '../src/types.ts'

const exec = promisify(execFile)

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

const DECISIONS_BEFORE = '# Decisions\n\n## Weighted bucket sampling\n\nAdopted after review.\n'
const EXPERIMENTS_BEFORE = '# Experiments\n\n## Baseline run\n\nCommand: node baseline.js\nResult: ok\nConclusion: baseline holds.\n'
const CURRENT_STATE_BEFORE = '# Current State\n\n## Progress\n\nNothing yet.\n'

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v06-writeback-'))
  dirs.push(root)
  await exec('git', ['init', '-b', 'main'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.test'], { cwd: root })
  await exec('git', ['config', 'user.name', 'test'], { cwd: root })
  await exec('git', ['config', 'core.autocrlf', 'false'], { cwd: root })
  await mkdirRecursive(join(root, 'harness/context'))
  await writeFile(join(root, 'harness/context/AGENTS.md'), '# Agents\n\nBe safe and honest.\n')
  await writeFile(join(root, 'harness/context/CURRENT_STATE.md'), CURRENT_STATE_BEFORE)
  await writeFile(join(root, 'harness/context/CODEX_HANDOFF.md'), '# Handoff Rules\n\nReport honestly.\n')
  await writeFile(join(root, 'harness/context/PROJECT_CONTEXT.md'), '# Project Context\n\n## Widget\nThe widget must stay blue.\n')
  await writeFile(join(root, 'harness/context/DECISIONS.md'), DECISIONS_BEFORE)
  await writeFile(join(root, 'harness/context/EXPERIMENTS.md'), EXPERIMENTS_BEFORE)
  await writeFile(join(root, 'widget.ts'), 'export const color = "blue"\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-m', 'baseline'], { cwd: root })
  return root
}

async function mkdirRecursive(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}

function executorFinal(report: Partial<ExecutorReport> & { status: ExecutorReport['status'] }): string {
  return `Work done.\n\n\`\`\`json dsh-executor-report\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

function reviewerFinal(verdict: 'pass' | 'rework' | 'blocked'): string {
  return `Reviewed.\n\n\`\`\`json dsh-review-report\n${JSON.stringify({ verdict, reasons: [], unmetCriteria: [], suspiciousClaims: [] })}\n\`\`\`\n`
}

function createEnvironment(root: string, mode: 'disabled' | 'proposal' | 'apply') {
  const ctx = new Context()
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
  const startCalls: { provider: string; label: string; prompt: string }[] = []
  let executorQueue: string[] = []
  let reviewerQueue: string[] = []
  const subagents = {
    getProvider: (name: string) => ({ name, capabilities: {} }),
    start: vi.fn(async (provider: string, request: { label: string; prompt: { type: string; text: string }[] }) => {
      const prompt = request.prompt.map(block => block.text).join('')
      startCalls.push({ provider, label: request.label, prompt })
      const text = request.label === 'Independent review' ? reviewerQueue.shift() : executorQueue.shift()
      if (text === undefined) throw new Error(`unexpected start for "${provider}"`)
      return {
        id: `run-${startCalls.length}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
        dispose: vi.fn(),
      }
    }),
  }
  ;(ctx as any).subagents = subagents
  const service = new ContextDelegationService(ctx, {
    providerName: 'spawn',
    contextWriteback: mode,
  })
  const parent = { id: 'p1', session: { id: 'p1', header: { cwd: root } } } as unknown as Agent
  return {
    ctx,
    service,
    startCalls,
    scriptExecutor: (outputs: string[]) => { executorQueue = [...outputs] },
    scriptReviewer: (outputs: string[]) => { reviewerQueue = [...outputs] },
    exec: { parent, signal: new AbortController().signal },
  }
}

const BASE_INPUT: DelegationInput = { task: 'Do the thing.', acceptance_criteria: ['C1: done'] }

function passingExecutorReport(contextUpdate: NonNullable<ExecutorReport['contextUpdate']>): string {
  return executorFinal({
    status: 'completed',
    summary: 'Changed the widget color.',
    filesChanged: ['widget.ts'],
    verification: [],
    risks: [],
    contextUpdate,
  })
}

describe('V0.6 reviewed context write-back (roadmap 6.8)', () => {
  it('RED 1: a rework-limited loop generates no write-back', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'apply')
    env.scriptExecutor([
      passingExecutorReport({ decisions: [{ decision: 'Adopt red widget', rationale: 'reviewed' }] }),
      executorFinal({ status: 'completed', summary: 'attempt 2', filesChanged: [], verification: [], risks: [] }),
    ])
    env.scriptReviewer([reviewerFinal('rework'), reviewerFinal('rework')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.review!.outcome).toBe('rework')
    expect(result.contextWriteback).toBeUndefined()
    const decisions = await readFile(join(root, 'harness/context/DECISIONS.md'), 'utf8')
    expect(decisions).toBe(DECISIONS_BEFORE)
  })

  it('RED 2: a blocked review writes nothing', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'apply')
    env.scriptExecutor([
      executorFinal({
        status: 'blocked',
        summary: 'infrastructure missing',
        filesChanged: [],
        verification: [],
        risks: [],
        contextUpdate: { decisions: [{ decision: 'Blocked decision', rationale: 'x' }] },
      }),
    ])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.review!.outcome).toBe('blocked')
    expect(result.contextWriteback).toBeUndefined()
    const decisions = await readFile(join(root, 'harness/context/DECISIONS.md'), 'utf8')
    expect(decisions).toBe(DECISIONS_BEFORE)
  })

  it('RED 3: default proposal mode never modifies files but attaches auditable patches', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'proposal')
    env.scriptExecutor([
      passingExecutorReport({
        currentState: ['Widget color is now red.'],
        decisions: [{ decision: 'Adopt red widget', rationale: 'verified by review' }],
      }),
    ])
    env.scriptReviewer([reviewerFinal('pass')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.contextWriteback).toBeDefined()
    expect(result.contextWriteback!.mode).toBe('proposal')
    expect(result.contextWriteback!.status).toBe('proposed')
    expect(result.contextWriteback!.patches.length).toBeGreaterThanOrEqual(2)
    for (const patch of result.contextWriteback!.patches) {
      expect(patch.reason).toBeTruthy()
    }
    const decisions = await readFile(join(root, 'harness/context/DECISIONS.md'), 'utf8')
    const currentState = await readFile(join(root, 'harness/context/CURRENT_STATE.md'), 'utf8')
    expect(decisions).toBe(DECISIONS_BEFORE)
    expect(currentState).toBe(CURRENT_STATE_BEFORE)
  })

  it('RED 4: apply mode updates only the allowed context file inside contextRoot', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'apply')
    env.scriptExecutor([
      passingExecutorReport({ decisions: [{ decision: 'Adopt red widget', rationale: 'verified by review' }] }),
    ])
    env.scriptReviewer([reviewerFinal('pass')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.contextWriteback!.status).toBe('applied')
    const decisions = await readFile(join(root, 'harness/context/DECISIONS.md'), 'utf8')
    expect(decisions).toContain('Adopt red widget')
    expect(decisions).toContain('## Adopt red widget')
    expect(decisions.startsWith(DECISIONS_BEFORE)).toBe(true)
  })

  it('RED 5: escape attempts and unknown targets are dropped, nothing is written', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'apply')
    env.scriptExecutor([
      executorFinal({
        status: 'completed',
        summary: 'x',
        filesChanged: [],
        verification: [],
        risks: [],
        // Raw proposal with hostile targets; the executor cannot express a
        // target outside the four context files.
        contextUpdate: {
          projectContext: ['Legitimate note.'],
          // Hostile input arrives as untyped JSON: an unknown "target" field
          // rides along on a decision entry and must be inert.
          decisions: [{ decision: 'Escaped', rationale: 'x', target: '../../outside.md' }],
        } as unknown as NonNullable<ExecutorReport['contextUpdate']>,
      }),
    ])
    env.scriptReviewer([reviewerFinal('pass')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.contextWriteback!.status).toBe('applied')
    const projectContext = await readFile(join(root, 'harness/context/PROJECT_CONTEXT.md'), 'utf8')
    expect(projectContext).toContain('Legitimate note.')
    const decisions = await readFile(join(root, 'harness/context/DECISIONS.md'), 'utf8')
    // The hostile "target" field is not part of the proposal shape; the
    // decision itself is still appended to DECISIONS inside contextRoot.
    expect(decisions).toContain('Escaped')
    await expect(readFile(join(root, 'outside.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '..', 'outside.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('RED 6: an experiment without an executed command and result is dropped', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'apply')
    env.scriptExecutor([
      passingExecutorReport({
        experiments: [
          { experiment: 'Claimed run without evidence', result: 'should have passed' },
          { experiment: 'Real run', command: 'node verify.js', result: 'exit 0', conclusion: 'verified' },
        ],
      }),
    ])
    env.scriptReviewer([reviewerFinal('pass')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.contextWriteback!.status).toBe('applied')
    const experiments = await readFile(join(root, 'harness/context/EXPERIMENTS.md'), 'utf8')
    expect(experiments).toContain('Real run')
    expect(experiments).toContain('node verify.js')
    expect(experiments).not.toContain('Claimed run without evidence')
    expect(result.contextWriteback!.patches.every(patch => patch.reason.length > 0)).toBe(true)
  })

  it('RED 7: a successful apply advances the context fingerprint revision', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, 'apply')
    env.scriptExecutor([
      passingExecutorReport({ decisions: [{ decision: 'Adopt red widget', rationale: 'verified by review' }] }),
    ])
    env.scriptReviewer([reviewerFinal('pass')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    const writeback = result.contextWriteback!
    expect(writeback.status).toBe('applied')
    expect(writeback.fingerprintBefore).toBeTruthy()
    expect(writeback.fingerprintAfter).toBeTruthy()
    expect(writeback.fingerprintBefore).not.toBe(writeback.fingerprintAfter)
  })
})
