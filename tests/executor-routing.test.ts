import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ContextDelegationService, buildDelegationHandoff } from '../src/index.ts'
import { resolveExecutorRouting } from '../src/executor-routing.ts'
import { assertDelegationInput } from '../src/tool.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationInput, DelegationResult, ExecutorReport } from '../src/types.ts'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v05-routing-'))
  dirs.push(root)
  return root
}

function executorFinal(report: Partial<ExecutorReport> & { status: ExecutorReport['status'] }): string {
  return `Work done.\n\n\`\`\`json dsh-executor-report\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

function reviewerFinal(verdict: 'pass' | 'rework' | 'blocked'): string {
  return `Reviewed.\n\n\`\`\`json dsh-review-report\n${JSON.stringify({ verdict, reasons: [], unmetCriteria: [], suspiciousClaims: [] })}\n\`\`\`\n`
}

function createEnvironment(root: string, providers: string[], executorOutputs: string[], reviewerOutputs: string[]) {
  const ctx = new Context()
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
  const startCalls: { provider: string; label: string; prompt: string; agentOptions?: unknown }[] = []
  let executorQueue = [...executorOutputs]
  let reviewerQueue = [...reviewerOutputs]
  const subagents = {
    getProvider: (name: string) => (providers.includes(name) ? { name, capabilities: { agentOptions: true } } : undefined),
    start: vi.fn(async (provider: string, request: { label: string; prompt: { type: string; text: string }[]; agentOptions?: unknown }) => {
      const prompt = request.prompt.map(block => block.text).join('')
      startCalls.push({ provider, label: request.label, prompt, agentOptions: request.agentOptions })
      const isReviewer = request.label === 'Independent review'
      const text = isReviewer ? reviewerQueue.shift() : executorQueue.shift()
      if (text === undefined) throw new Error(`unexpected start for "${provider}" (script exhausted)`)
      return {
        id: `run-${startCalls.length}`,
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }),
        dispose: vi.fn(),
      }
    }),
  }
  ;(ctx as any).subagents = subagents
  const parent = { id: 'p1', session: { id: 'p1', header: { cwd: root } } } as unknown as Agent
  return { ctx, startCalls, parent }
}

const BASE_INPUT: DelegationInput = {
  task: 'Do the thing.',
  acceptance_criteria: ['C1: done'],
}

describe('V0.5 backend-neutral routing (roadmap 5.7)', () => {
  it('RED: an unregistered executor fails loud with CODEX_PROVIDER_NOT_FOUND', async () => {
    const root = await createRepo()
    const env = createEnvironment(root, ['spawn'], [], [])
    const service = new ContextDelegationService(env.ctx, {
      providerName: 'spawn',
      executorRouting: { implementation: { provider: 'nonexistent-backend' }, reviewer: { provider: 'spawn' } },
    })
    await expect(service.delegate(BASE_INPUT, { parent: env.parent, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CODEX_PROVIDER_NOT_FOUND' })
    expect(env.startCalls).toHaveLength(0)
  })

  it('RED: an executor infrastructure failure inside the reviewed loop becomes BLOCKED, not a thrown crash', async () => {
    const root = await createRepo()
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
    const subagents = {
      getProvider: (name: string) => ({ name, capabilities: {} }),
      start: vi.fn(async () => {
        throw new Error('backend crashed at startup')
      }),
    }
    ;(ctx as any).subagents = subagents
    const service = new ContextDelegationService(ctx, {
      providerName: 'spawn',
      executorRouting: { implementation: { provider: 'spawn' }, reviewer: { provider: 'spawn' } },
    })
    const parent = { id: 'p1', session: { id: 'p1', header: { cwd: root } } } as unknown as Agent
    const result = await service.delegate(BASE_INPUT, { parent, signal: new AbortController().signal }) as DelegationResult
    expect(result.review).toBeDefined()
    expect(result.review!.outcome).toBe('blocked')
    expect(result.review!.reviews).toHaveLength(0)
  })

  it('RED: routing cannot be overridden by model-controlled input fields', () => {
    expect(() => assertDelegationInput({
      task: 't',
      provider: 'my-own-provider',
    } as unknown as DelegationInput)).toThrow()
    expect(() => assertDelegationInput({
      task: 't',
      model: 'own-model',
      executor: 'own-executor',
    } as unknown as DelegationInput)).toThrow()
  })

  it('RED: reviewer and implementation can route to different providers', async () => {
    const root = await createRepo()
    const env = createEnvironment(
      root,
      ['spawn', 'codex'],
      [executorFinal({ status: 'completed', summary: 's', filesChanged: [], verification: [], risks: [] })],
      [reviewerFinal('pass')],
    )
    const service = new ContextDelegationService(env.ctx, {
      executorRouting: { implementation: { provider: 'spawn' }, reviewer: { provider: 'codex' } },
    })
    const result = await service.delegate(BASE_INPUT, { parent: env.parent, signal: new AbortController().signal }) as DelegationResult
    const executorCall = env.startCalls.find(call => call.label !== 'Independent review')!
    const reviewerCall = env.startCalls.find(call => call.label === 'Independent review')!
    expect(executorCall.provider).toBe('spawn')
    expect(reviewerCall.provider).toBe('codex')
    expect(result.review!.outcome).toBe('completed')
  })

  it('RED: context selection is independent of the routed executor', async () => {
    const root = await createRepo()
    const envA = createEnvironment(root, ['spawn'], [], [])
    const envB = createEnvironment(root, ['spawn', 'codex'], [], [])
    const serviceA = new ContextDelegationService(envA.ctx, {
      providerName: 'spawn',
    })
    const serviceB = new ContextDelegationService(envB.ctx, {
      executorRouting: { implementation: { provider: 'codex' }, reviewer: { provider: 'codex' } },
    })
    const input: DelegationInput = { task: 'non-uniform sampling preferred path', relevant_files: ['src/av2/sampling.ts'] }
    const exec = { parent: envA.parent, signal: new AbortController().signal }
    const previewA = await serviceA.preview(input, exec)
    const previewB = await serviceB.preview(input, { parent: envB.parent, signal: exec.signal })
    expect(previewB.retrieved.map(chunk => JSON.stringify(chunk.headingPath))).toEqual(previewA.retrieved.map(chunk => JSON.stringify(chunk.headingPath)))
  })

  it('RED: the same handoff text enters different executor adapters unchanged', async () => {
    const root = await createRepo()
    const context = {
      workspaceRoot: root,
      files: [{ id: 'agents' as const, relativePath: 'AGENTS.md', content: 'Be safe.', originalChars: 8, includedChars: 8, truncated: false }],
      missingFiles: [],
      truncatedFiles: [],
      totalChars: 8,
    }
    const input: DelegationInput = { task: 'shared task' }
    const handoffA = buildDelegationHandoff({ input, context, relevantFiles: [] })
    const handoffB = buildDelegationHandoff({ input, context, relevantFiles: [] })
    expect(handoffB).toBe(handoffA)

    const env = createEnvironment(
      root,
      ['spawn', 'codex'],
      [executorFinal({ status: 'completed', summary: 's', filesChanged: [], verification: [], risks: [] })],
      [reviewerFinal('pass')],
    )
    const service = new ContextDelegationService(env.ctx, {
      executorRouting: { implementation: { provider: 'spawn' }, reviewer: { provider: 'codex' } },
    })
    await service.delegate(BASE_INPUT, { parent: env.parent, signal: new AbortController().signal })
    const executorPrompt = env.startCalls.find(call => call.label !== 'Independent review')!.prompt
    expect(executorPrompt).toContain('Do the thing.')
  })

  it('routing resolves deterministically with deprecated keys as fallbacks', () => {
    const routing = resolveExecutorRouting({
      providerName: 'legacy-impl',
      reviewProviderName: 'legacy-review',
    } as never)
    expect(routing.implementation.provider).toBe('legacy-impl')
    expect(routing.reviewer.provider).toBe('legacy-review')

    const overridden = resolveExecutorRouting({
      providerName: 'legacy-impl',
      executorRouting: { implementation: { provider: 'spawn' }, reviewer: { provider: 'spawn' } },
    } as never)
    expect(overridden.implementation.provider).toBe('spawn')
    expect(overridden.reviewer.provider).toBe('spawn')

    const defaulted = resolveExecutorRouting({} as never)
    expect(defaulted.implementation.provider).toBe('codex')
    expect(defaulted.reviewer.provider).toBe('codex')
  })
})
