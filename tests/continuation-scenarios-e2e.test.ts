import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextDelegationService,
} from '../src/index.ts'
import { parseContinuationHandoff } from '../src/continuation-handoff.ts'
import { apply as applyExpert } from '../src/tool.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DelegationResult } from '../src/types.ts'

describe('V03-08 Continuation scenario mock integration: lifecycle and fault injection', () => {
  let tempBase: string
  let workspaceDir: string
  let ctx: Context
  let tools: ToolDefinition[]
  let subagents: any
  let childCounter: number

  beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'dsh-v03-e2e-'))
    workspaceDir = join(tempBase, 'workspace')
    await mkdir(join(workspaceDir, 'harness', 'context'), { recursive: true })

    await writeFile(join(workspaceDir, 'AGENTS.md'), '# Agents Policy\nRule 1: Always write tests.\n')
    await writeFile(join(workspaceDir, 'harness', 'context', 'CURRENT_STATE.md'), '# Current State\nFeature auth in progress.\n')
    await writeFile(join(workspaceDir, 'harness', 'context', 'PROJECT_CONTEXT.md'), '# Architecture\nUse pure functions.\n')

    ctx = new Context()
    new LocalFileSystem(ctx, {
      cwd: workspaceDir,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    })

    childCounter = 0
    subagents = {
      getProvider: vi.fn((name: string) => {
        if (name === 'spawn') {
          return {
            name: 'spawn',
            capabilities: {},
            prepareContinuable: async () => ({}),
          }
        }
        if (name === 'codex') {
          return {
            name: 'codex',
            capabilities: {},
            // Lacks prepareContinuable
          }
        }
        return undefined
      }),
      startContinuable: vi.fn(async () => {
        childCounter += 1
        return {
          childId: `child-${childCounter}`,
          messageId: `msg-${childCounter}-1`,
        }
      }),
      sendMessage: vi.fn(async () => `msg-followup`),
      interrupt: vi.fn().mockResolvedValue({ ok: true }),
      drainContinuableChildren: vi.fn().mockResolvedValue(undefined),
    }
    ctx.subagents = subagents

    new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    tools = []
    ctx.tools = { register: (tool: ToolDefinition) => { tools.push(tool) } } as any
    applyExpert(ctx)
  })

  afterEach(async () => {
    if (tempBase) {
      await rm(tempBase, { recursive: true, force: true })
    }
  })

  function makeParent(id = 'parent-agent'): Agent {
    return {
      id,
      session: {
        id,
        header: { cwd: workspaceDir },
      },
    } as unknown as Agent
  }

  function makeExec(agent: Agent, signal = new AbortController().signal) {
    return { agent, signal } as any
  }

  it('Scenarios 1-4: multi-turn task with delta, history preservation, and state updates', async () => {
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const parent = makeParent()

    // Round 1: Initial full turn
    const turn1Promise = expertTool.execute({
      task: 'Task A: Implement helper with SECRET_HISTORY_SALT_4242 in state',
      mode: 'continue',
      delegation_key: 'session-helper',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))
    const prompt1 = subagents.startContinuable.mock.calls[0][0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Helper created. State initialized with SECRET_HISTORY_SALT_4242. [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })

    const res1 = (await turn1Promise) as DelegationResult
    expect(res1.success).toBe(true)
    expect(res1.runId).toBe('child-1')
    expect(res1.continuation?.reused).toBe(false)
    expect(res1.continuation?.contextMode).toBe('full')

    // Inspect Round 1 handoff
    expect(payload1.contextMode).toBe('full')

    // Mutate CURRENT_STATE on disk
    await writeFile(
      join(workspaceDir, 'harness', 'context', 'CURRENT_STATE.md'),
      '# Current State\nFeature auth in progress.\nAdded new constraint: Helper must support async mode.\n',
    )

    // Round 2: Continuation with delta
    const turn2Promise = expertTool.execute({
      task: 'Task B: Update helper with async support. Recall the state salt.',
      mode: 'continue',
      delegation_key: 'session-helper',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.sendMessage).toHaveBeenCalledTimes(1))

    // Verify subagent sendMessage called with delta
    expect(subagents.sendMessage).toHaveBeenCalledTimes(1)
    const prompt2 = subagents.sendMessage.mock.calls[0][2][0].text
    const payload2 = parseContinuationHandoff(prompt2)
    expect(payload2.contextMode).toBe('delta')
    expect(payload2.baseRevision).toBe(payload1.revision)
    expect(payload2.context.changed?.some(u => u.relativePath.includes('CURRENT_STATE'))).toBe(true)

    // Child responds recalling Round 1 history fact
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Async support added. Verified salt is SECRET_HISTORY_SALT_4242. [DSH_CONTEXT_ACK: revision=${payload2.revision} baseRevision=${payload2.baseRevision}]` }],
    })

    const res2 = (await turn2Promise) as DelegationResult
    expect(res2.success).toBe(true)
    expect(res2.runId).toBe('child-1') // Same child
    expect(res2.continuation?.reused).toBe(true)
    expect(res2.continuation?.contextMode).toBe('delta')
    expect(res2.codexFinal).toContain('SECRET_HISTORY_SALT_4242')
  })

  it('Scenario 5: Policy modification (AGENTS.md) invalidates session, releases old child, starts new child', async () => {
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const parent = makeParent()

    // Turn 1
    const turn1Promise = expertTool.execute({
      task: 'Turn 1 under policy v1',
      mode: 'continue',
      delegation_key: 'policy-test',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))
    const prompt1 = subagents.startContinuable.mock.calls[0][0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Turn 1 done [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })
    const res1 = (await turn1Promise) as DelegationResult
    expect(res1.runId).toBe('child-1')

    // Modify AGENTS.md (policy revision changes!)
    await writeFile(join(workspaceDir, 'AGENTS.md'), '# Agents Policy\nRule 1: Always write tests.\nRule 2: Never skip validation.\n')

    // Turn 2 with same delegation key
    const turn2Promise = expertTool.execute({
      task: 'Turn 2 under policy v2',
      mode: 'continue',
      delegation_key: 'policy-test',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(2))

    // Old child-1 must have been drained/released
    expect(subagents.drainContinuableChildren).toHaveBeenCalledWith(parent, ['child-1'])

    // New child-2 started
    const prompt2 = subagents.startContinuable.mock.calls[1][0].request.prompt[0].text
    const payload2 = parseContinuationHandoff(prompt2)
    ctx.emit('subagent/end' as any, {
      id: 'child-2',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Turn 2 done with new policy [DSH_CONTEXT_ACK: revision=${payload2.revision}]` }],
    })

    const res2 = (await turn2Promise) as DelegationResult
    expect(res2.runId).toBe('child-2')
    expect(res2.continuation?.reused).toBe(false)
    expect(res2.continuation?.contextMode).toBe('full')
  })

  it('Scenario 6: Turn failure rolls back pending snapshot and double drain failure is handled gracefully', async () => {
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const parent = makeParent()

    // Turn 1 success
    const turn1Promise = expertTool.execute({
      task: 'Initial task',
      mode: 'continue',
      delegation_key: 'rollback-test',
    }, makeExec(parent))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))
    const prompt1 = subagents.startContinuable.mock.calls[0][0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Initial success [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })
    await turn1Promise

    // Turn 2 failure
    subagents.sendMessage.mockRejectedValueOnce(new Error('Network transport crash'))
    // Also make drain throw to test double-failure resilience
    subagents.drainContinuableChildren.mockRejectedValueOnce(new Error('Drain failed'))

    await expect(expertTool.execute({
      task: 'Failing follow-up',
      mode: 'continue',
      delegation_key: 'rollback-test',
    }, makeExec(parent))).rejects.toThrowError(/CODEX_DELEGATION_FAILED/)
  })

  it('Scenario 7: Cancellation during execution aborts turn, signals interrupt, and reports workspaceMayHaveChanged', async () => {
    const expertTool = tools.find(t => t.name === 'codex_expert')!
    const parent = makeParent()
    const controller = new AbortController()

    const turnPromise = expertTool.execute({
      task: 'Task to cancel mid-flight',
      mode: 'continue',
      delegation_key: 'cancel-test',
    }, makeExec(parent, controller.signal))

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalledTimes(1))

    // Abort
    controller.abort()

    expect(subagents.interrupt).toHaveBeenCalledWith('child-1', {
      kind: 'ancestor',
      agent: parent,
    })

    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'aborted',
      lastAssistantMessage: [],
    })

    try {
      await turnPromise
      expect.fail('Should have rejected')
    } catch (err: any) {
      expect(err.code).toBe('CODEX_CANCELLED')
      expect(err.details.workspaceMayHaveChanged).toBe(true)
      expect(err.details.codexInvoked).toBe(true)
    }
  })

  it('Scenario 8: Continuation requested on provider without continuable capability fails explicitly', async () => {
    // Reconfigure service with provider 'codex' for continuation
    const ctxCodex = new Context()
    new LocalFileSystem(ctxCodex, { cwd: workspaceDir, diffBasisMaxBytes: 10 * 1024 * 1024 })
    ctxCodex.subagents = subagents
    new ContextDelegationService(ctxCodex, {
      continuationEnabled: true,
      continuationProviderName: 'codex', // codex lacks prepareContinuable!
    })

    const codexTools: ToolDefinition[] = []
    ctxCodex.tools = { register: (tool: ToolDefinition) => { codexTools.push(tool) } } as any
    applyExpert(ctxCodex)
    const expert = codexTools.find(t => t.name === 'codex_expert')!

    const parent = makeParent('parent-codex')
    try {
      await expert.execute({
        task: 'Task that expects continuation on codex',
        mode: 'continue',
        delegation_key: 'fail-key',
      }, makeExec(parent))
      expect.fail('Should have rejected')
    } catch (err: any) {
      expect(err.code).toBe('UNSUPPORTED_CONTINUATION_PROVIDER')
      expect(err.message).toContain('codex')
      expect(err.message).toContain('prepareContinuable')
    }
  })
})
