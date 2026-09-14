import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ContextDelegationService, recentDelegationTraces } from '../src/index.ts'
import { apply as applyExpert } from '../src/tool.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
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

const EXECUTOR_MARKER = 'EXECUTOR_SECRET_TEXT_7f3a'
const VERIFICATION_MARKER = 'VERIFICATION_OUTPUT_SECRET_91bd'
const REVIEW_REASON_MARKER = 'REVIEW_REASON_SECRET_5c2e'
const EVIDENCE_FILE_MARKER = 'EVIDENCE_FILENAME_SECRET_d4e6'

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v07-trace-'))
  dirs.push(root)
  await exec('git', ['init', '-b', 'main'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.test'], { cwd: root })
  await exec('git', ['config', 'user.name', 'test'], { cwd: root })
  await mkdirRecursive(join(root, 'harness/context'))
  await writeFile(join(root, 'harness/context/AGENTS.md'), '# Agents\n\nBe safe and honest.\n')
  await writeFile(join(root, 'harness/context/CURRENT_STATE.md'), '# Current State\n\nNothing.\n')
  await writeFile(join(root, 'harness/context/CODEX_HANDOFF.md'), '# Handoff Rules\n\nReport honestly.\n')
  await writeFile(join(root, 'harness/context/DECISIONS.md'), '# Decisions\n\n## Baseline\n\nHolds.\n')
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
  const payload = JSON.stringify(report, null, 2)
  return `${EXECUTOR_MARKER}\n\n\`\`\`json dsh-executor-report\n${payload}\n\`\`\`\n`
}

function reviewerFinal(verdict: 'pass' | 'rework' | 'blocked', reason: string): string {
  return `Reviewed.\n\n\`\`\`json dsh-review-report\n${JSON.stringify({ verdict, reasons: [reason], unmetCriteria: [], suspiciousClaims: [] })}\n\`\`\`\n`
}

interface StartCall {
  provider: string
  label: string
  prompt: string
}

function createEnvironment(root: string, options?: { contextWriteback?: 'disabled' | 'proposal' | 'apply' }) {
  const ctx = new Context()
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
  const startCalls: StartCall[] = []
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
    contextWriteback: options?.contextWriteback ?? 'apply',
  })
  const tools: ToolDefinition[] = []
  ;(ctx as any).tools = { register: (tool: ToolDefinition) => { tools.push(tool) } } as never
  applyExpert(ctx)
  const parent = { id: 'p1', session: { id: 'p1', header: { cwd: root } } } as unknown as Agent
  return {
    ctx,
    service,
    tools,
    startCalls,
    scriptExecutor: (outputs: string[]) => { executorQueue = [...outputs] },
    scriptReviewer: (outputs: string[]) => { reviewerQueue = [...outputs] },
    exec: { parent, signal: new AbortController().signal },
  }
}

const BASE_INPUT: DelegationInput = { task: 'Do the traced thing.', acceptance_criteria: ['C1: done'] }

describe('V0.7 observability (roadmap section 7)', () => {
  it('records every reviewed-loop stage in order with a finished outcome', async () => {
    const root = await createRepo()
    const env = createEnvironment(root)
    env.scriptExecutor([
      executorFinal({
        status: 'completed',
        summary: 's',
        filesChanged: ['widget.ts'],
        verification: [],
        risks: [],
        contextUpdate: { decisions: [{ decision: 'Traced decision', rationale: 'reviewed' }] },
      }),
    ])
    env.scriptReviewer([reviewerFinal('pass', 'ok')])
    const tracesBefore = recentDelegationTraces().length

    await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    const traces = recentDelegationTraces()
    expect(traces.length).toBe(tracesBefore + 1)
    const trace = traces[traces.length - 1]!
    const stages = trace.events.map(event => event.stage)
    expect(stages).toEqual([
      'context', 'executor-start', 'executor-end', 'evidence', 'verification', 'review', 'write-back',
    ])
    expect(trace.outcome).toBe('completed')
    expect(trace.finishedAt).toBeGreaterThanOrEqual(trace.startedAt)
    expect(trace.executor).toBe('spawn')
    expect(trace.reviewer).toBe('spawn')
    expect(trace.selectedContextChars).toBeGreaterThan(0)
  })

  it('records a fresh unreviewed delegation with context and executor stages only', async () => {
    const root = await createRepo()
    const env = createEnvironment(root)
    env.scriptExecutor([executorFinal({ status: 'completed', summary: 's', filesChanged: [], verification: [], risks: [] })])

    await env.service.delegate({ task: 'Fresh task' }, env.exec) as DelegationResult

    const trace = recentDelegationTraces().at(-1)!
    expect(trace.events.map(event => event.stage)).toEqual(['context', 'executor-start', 'executor-end'])
    expect(trace.outcome).toBe('completed')
    expect(trace.reviewer).toBeUndefined()
  })

  it('never records final text, verification output, evidence file names, or review reasons', async () => {
    const root = await createRepo()
    const env = createEnvironment(root)
    env.scriptExecutor([
      executorFinal({
        status: 'completed',
        summary: 's',
        filesChanged: [EVIDENCE_FILE_MARKER],
        verification: [],
        risks: [],
        contextUpdate: { decisions: [{ decision: 'Traced decision', rationale: 'reviewed' }] },
      }),
    ])
    env.scriptReviewer([reviewerFinal('pass', REVIEW_REASON_MARKER)])

    const result = await env.service.delegate({
      ...BASE_INPUT,
      verification_commands: [`node -e "console.log('${VERIFICATION_MARKER}')"`],
    }, env.exec) as DelegationResult

    expect(result.codexFinal).toContain(EXECUTOR_MARKER)
    const serialized = JSON.stringify(recentDelegationTraces())
    expect(serialized).not.toContain(EXECUTOR_MARKER)
    expect(serialized).not.toContain(VERIFICATION_MARKER)
    expect(serialized).not.toContain(REVIEW_REASON_MARKER)
    expect(serialized).not.toContain(EVIDENCE_FILE_MARKER)
  })

  it('bounds the trace ring buffer', async () => {
    const root = await createRepo()
    const env = createEnvironment(root)
    for (let index = 0; index < 25; index++) {
      env.scriptExecutor([executorFinal({ status: 'completed', summary: `run ${index}`, filesChanged: [], verification: [], risks: [] })])
      await env.service.delegate({ task: `Trace bound ${index}` }, env.exec) as DelegationResult
    }
    const traces = recentDelegationTraces()
    expect(traces.length).toBeLessThanOrEqual(20)
    expect(traces.at(-1)!.taskId).toContain('Trace bound 24')
  })

  it('records rework rounds', async () => {
    const root = await createRepo()
    const env = createEnvironment(root)
    env.scriptExecutor([
      executorFinal({ status: 'completed', summary: 'attempt 1', filesChanged: [], verification: [], risks: [] }),
      executorFinal({ status: 'completed', summary: 'attempt 2', filesChanged: [], verification: [], risks: [] }),
    ])
    env.scriptReviewer([reviewerFinal('rework', 'not yet'), reviewerFinal('pass', 'ok')])

    const result = await env.service.delegate(BASE_INPUT, env.exec) as DelegationResult

    expect(result.review!.outcome).toBe('completed')
    const stages = recentDelegationTraces().at(-1)!.events.map(event => event.stage)
    expect(stages.filter(stage => stage === 'rework')).toHaveLength(1)
    expect(stages.filter(stage => stage === 'review')).toHaveLength(2)
  })

  it('records a failure with the stable error code only', async () => {
    const root = await createRepo()
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
    const crashDetail = 'BACKEND_CRASH_DETAIL_SECRET_33aa'
    const subagents = {
      getProvider: () => ({ name: 'spawn', capabilities: {} }),
      start: vi.fn(async () => {
        throw new Error(crashDetail)
      }),
    }
    ;(ctx as any).subagents = subagents
    const service = new ContextDelegationService(ctx, { providerName: 'spawn' })
    const parent = { id: 'p1', session: { id: 'p1', header: { cwd: root } } } as unknown as Agent

    await expect(service.delegate({ task: 'Failing task' }, { parent, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CODEX_DELEGATION_FAILED' })

    const serialized = JSON.stringify(recentDelegationTraces())
    expect(serialized).not.toContain(crashDetail)
    expect(serialized).toContain('CODEX_DELEGATION_FAILED')
  })

  it('registers delegation_debug and returns recent traces', async () => {
    const root = await createRepo()
    const env = createEnvironment(root)
    env.scriptExecutor([executorFinal({ status: 'completed', summary: 's', filesChanged: [], verification: [], risks: [] })])
    await env.service.delegate({ task: 'Debug me' }, env.exec) as DelegationResult

    const debugTool = env.tools.find(tool => tool.name === 'delegation_debug')
    expect(debugTool).toBeDefined()
    const output = await debugTool!.execute({}, { agent: env.exec.parent, signal: env.exec.signal } as never)
    const text = JSON.stringify(output)
    expect(text).toContain('traceId')
    expect(text).toContain('Debug me')
  })
})
