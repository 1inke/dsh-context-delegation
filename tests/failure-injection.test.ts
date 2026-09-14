import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextDelegationService,
  applyContextPatches,
  runVerificationCommands,
  validateRelevantFiles,
} from '../src/index.ts'
import { parseContinuationHandoff } from '../src/continuation-handoff.ts'
import { loadContextCandidates } from '../src/context-loader.ts'
import { resolveConfig } from '../src/config.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextPatch } from '../src/types.ts'

describe('V0.9 Failure Injection Suite (Roadmap §7 / V0.9)', () => {
  let tempBase: string
  let workspaceDir: string
  let outsideDir: string

  beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'dsh-v09-failure-'))
    workspaceDir = join(tempBase, 'workspace')
    outsideDir = join(tempBase, 'outside')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await mkdir(join(workspaceDir, 'harness', 'context'), { recursive: true })
    await writeFile(join(workspaceDir, 'AGENTS.md'), '# Agents\nBe safe.\n')
    await writeFile(join(workspaceDir, 'harness', 'context', 'CURRENT_STATE.md'), '# Current State\nInit.\n')
    await writeFile(join(workspaceDir, 'harness', 'context', 'CODEX_HANDOFF.md'), '# Rules\nRules.\n')
    await writeFile(join(outsideDir, 'secret.txt'), 'TOP_SECRET')
  })

  afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true })
  })

  function makeAgent(id: string, cwd: string): Agent {
    return {
      id,
      session: {
        id: `sess-${id}`,
        header: { cwd },
      },
    } as unknown as Agent
  }

  function createMockSubagents() {
    const mockSpawnProvider = {
      name: 'spawn',
      capabilities: {},
      prepareContinuable: async () => ({}),
    }
    const mockCodexProvider = {
      name: 'codex',
      capabilities: {},
    }
    return {
      getProvider: vi.fn((name: string) => {
        if (name === 'spawn') return mockSpawnProvider
        if (name === 'codex') return mockCodexProvider
        return undefined
      }),
      start: vi.fn(async () => ({
        id: 'fresh-run',
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'Fresh completed.' }],
        }),
        dispose: vi.fn(),
      })),
      startContinuable: vi.fn().mockResolvedValue({
        childId: 'child-1',
        messageId: 'msg-1',
      }),
      sendMessage: vi.fn().mockResolvedValue('msg-2'),
      interrupt: vi.fn().mockResolvedValue({ ok: true }),
      drainContinuableChildren: vi.fn().mockResolvedValue(undefined),
    }
  }

  // 1. Provider disappears during call
  it('Scenario 1: provider disappears or fails during execution in reviewed flow', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const subagents = createMockSubagents()
    subagents.start.mockRejectedValue(new Error('Provider disconnected unexpectedly'))
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      providerName: 'spawn',
      reviewProviderName: 'spawn',
    })

    const parent = makeAgent('p1', workspaceDir)
    const exec = { parent, signal: new AbortController().signal }

    // Reviewed flow: should degrade to blocked outcome rather than crashing the harness
    const outcome = await service.delegate({
      task: 'Do task with disappearing provider',
      relevant_files: [],
      acceptance_criteria: ['Must work'],
    }, exec)

    expect(outcome.review?.outcome).toBe('blocked')
    const notes = outcome.review?.finalExecutorReport.trustNotes ?? []
    expect(notes.some(n => n.includes('failed') || n.includes('disconnected') || n.includes('Provider disconnected'))).toBe(true)
  })

  // 2. Child crashes
  it('Scenario 2: child crashes or reports stopReason failed', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const subagents = createMockSubagents()
    subagents.start.mockResolvedValue({
      id: 'crashed-child',
      result: Promise.resolve({
        stopReason: 'failed',
        output: [],
        diagnostic: 'process exited with code 1',
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as any)
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      providerName: 'spawn',
      reviewProviderName: 'spawn',
    })

    const parent = makeAgent('p2', workspaceDir)
    const exec = { parent, signal: new AbortController().signal }

    const outcome = await service.delegate({
      task: 'Task where child crashes',
      relevant_files: [],
      acceptance_criteria: ['Must work'],
    }, exec)

    expect(outcome.review?.outcome).toBe('blocked')
    expect(outcome.review?.finalExecutorReport.status).toBe('failed')
  })

  // 3. Dispose fails
  it('Scenario 3: session dispose / drain failure does not mask primary execution error', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const subagents = createMockSubagents()
    subagents.sendMessage.mockRejectedValue(new Error('Subagent execution crashed'))
    subagents.drainContinuableChildren.mockRejectedValue(new Error('Drain failed critically'))
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    const parent = makeAgent('p3', workspaceDir)
    // Turn 1 setup
    const turn1Promise = service.delegate({
      task: 'Turn 1',
      relevant_files: [],
      mode: 'continue',
      delegation_key: 'drain-fail-key',
    }, { parent, signal: new AbortController().signal })

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalled())
    const calls = subagents.startContinuable.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const prompt1 = calls[0]![0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Turn 1 done [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })
    await turn1Promise

    // Turn 2: sendMessage fails AND drain fails
    await expect(service.delegate({
      task: 'Turn 2',
      relevant_files: [],
      mode: 'continue',
      delegation_key: 'drain-fail-key',
    }, { parent, signal: new AbortController().signal })).rejects.toThrowError(/CODEX_DELEGATION_FAILED/)
  })

  // 4. Filesystem read fails
  it('Scenario 4: filesystem read failure surfaces as explicit context error', async () => {
    const mockFs = {
      resolve: vi.fn().mockResolvedValue({ path: '/workspace' }),
      stat: vi.fn().mockRejectedValue(new Error('EPERM: disk read error')),
      readText: vi.fn().mockRejectedValue(new Error('EPERM: disk read error')),
    }

    const controller = new AbortController()
    const config = resolveConfig()
    await expect(loadContextCandidates({
      fs: mockFs as any,
      config,
      workspaceRoot: workspaceDir,
      signal: controller.signal,
    })).rejects.toThrowError(/WORKSPACE_NOT_FOUND/)
  })

  // 5. Context file oversized
  it('Scenario 5: context file exceeding limit is rejected or bounded', async () => {
    const hugeContent = '# Huge\n' + 'A'.repeat(20000)
    await writeFile(join(workspaceDir, 'AGENTS.md'), hugeContent)

    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const config = resolveConfig({ maxContextChars: 16000 })

    const { candidates } = await loadContextCandidates({
      fs: ctx.fs,
      config,
      workspaceRoot: workspaceDir,
      signal: new AbortController().signal,
    })

    const agentsSource = candidates.find(c => c.id === 'agents')
    expect(agentsSource).toBeDefined()
    expect(agentsSource?.sourceComplete).toBe(false)
    expect(agentsSource?.content.length).toBeLessThanOrEqual(16001)
  })

  // 6. Junction escape (Windows NTFS junction)
  it('Scenario 6: Windows NTFS junction pointing outside workspaceRoot is rejected with CONTEXT_PATH_ESCAPE', async () => {
    if (process.platform !== 'win32') return

    const junctionPath = join(workspaceDir, 'junction-to-outside')
    try {
      await symlink(outsideDir, junctionPath, 'junction')
    } catch {
      // If junction creation is disallowed by policy, skip gracefully
      return
    }

    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })

    await expect(validateRelevantFiles({
      fs: ctx.fs,
      workspaceRoot: workspaceDir,
      relevantFiles: ['junction-to-outside/secret.txt'],
      signal: new AbortController().signal,
    })).rejects.toThrowError(/CONTEXT_PATH_ESCAPE/)
  })

  // 7. Cancel during retrieval
  it('Scenario 7: signal abort during retrieval terminates with CODEX_CANCELLED and codexInvoked false', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const subagents = createMockSubagents()
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, { providerName: 'spawn' })

    const parent = makeAgent('p7', workspaceDir)
    const controller = new AbortController()
    controller.abort() // Cancel immediately

    try {
      await service.delegate({
        task: 'Cancelled early',
        relevant_files: [],
      }, { parent, signal: controller.signal })
      expect.fail('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CODEX_CANCELLED')
      expect(err.details?.codexInvoked).toBe(false)
      expect(err.details?.workspaceMayHaveChanged).toBe(false)
      expect(subagents.start).not.toHaveBeenCalled()
    }
  })

  // 8. Cancel during executor
  it('Scenario 8: signal abort during executor signals interrupt and flags workspaceMayHaveChanged', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const controller = new AbortController()
    const subagents = createMockSubagents()
    subagents.startContinuable.mockResolvedValue({ childId: 'child-c8', messageId: 'm8' })
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    const parent = makeAgent('p8', workspaceDir)
    const turnPromise = service.delegate({
      task: 'Task cancelled mid-flight',
      relevant_files: [],
      mode: 'continue',
      delegation_key: 'cancel-exec-key',
    }, { parent, signal: controller.signal })

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalled())

    // Abort while waiting
    controller.abort()

    await vi.waitFor(() => expect(subagents.interrupt).toHaveBeenCalledWith('child-c8', expect.anything()))

    ctx.emit('subagent/end' as any, {
      id: 'child-c8',
      provider: 'spawn',
      stopReason: 'aborted',
      lastAssistantMessage: [],
    })

    try {
      await turnPromise
      expect.fail('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CODEX_CANCELLED')
      expect(err.details?.codexInvoked).toBe(true)
      expect(err.details?.workspaceMayHaveChanged).toBe(true)
    }
  })

  // 9. Cancel during review
  it('Scenario 9: signal abort during review step terminates cleanly with CODEX_CANCELLED', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const controller = new AbortController()

    let callCount = 0
    const subagents = createMockSubagents()
    subagents.start.mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) {
        // Executor completes with valid report
        return {
          id: 'exec-child',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{
              type: 'text',
              text: 'Done!\n<!--- dsh-executor-report:begin -->\n{"summary":"Done","status":"completed","verification":[]}\n<!--- dsh-executor-report:end -->',
            }],
          }),
          dispose: vi.fn().mockResolvedValue(undefined),
        }
      }
      // Reviewer called: abort controller now and reject with aborted run
      controller.abort()
      return {
        id: 'reviewer-child',
        result: Promise.resolve({
          stopReason: 'aborted',
          output: [],
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
    })
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      providerName: 'spawn',
      reviewProviderName: 'spawn',
    })

    const parent = makeAgent('p9', workspaceDir)

    try {
      await service.delegate({
        task: 'Reviewed task cancelled in review',
        relevant_files: [],
        acceptance_criteria: ['Must pass review'],
      }, { parent, signal: controller.signal })
      expect.fail('Should have thrown CODEX_CANCELLED')
    } catch (err: any) {
      expect(err.code).toBe('CODEX_CANCELLED')
      expect(err.details?.workspaceMayHaveChanged).toBe(true)
    }
  })

  // 10. Write-back atomic check: oversized patch rejected before write
  it('Scenario 10: oversized write-back patch is rejected before write, leaving files untouched', async () => {
    const originalDecisions = '# Decisions\n\nOriginal decision content.\n'
    await writeFile(join(workspaceDir, 'harness', 'context', 'DECISIONS.md'), originalDecisions)

    const patch: ContextPatch = {
      target: 'DECISIONS',
      operation: 'append-section',
      headingPath: ['Huge Decision'],
      content: 'A'.repeat(50000),
      reason: 'Reason for huge decision',
    }

    // maxSnapshotBytes: 10000 -> 50000 char patch will fail assertParsable
    await expect(applyContextPatches({
      workspaceRoot: workspaceDir,
      contextRoot: 'harness/context',
      patches: [patch],
      maxSnapshotBytes: 10000,
    })).rejects.toThrowError(/exceeds maxSnapshotBytes/)

    // Target file must be completely untouched
    const after = await readFile(join(workspaceDir, 'harness', 'context', 'DECISIONS.md'), 'utf-8')
    expect(after).toBe(originalDecisions)
  })

  // 11. Verification timeout
  it('Scenario 11: verification command timing out reports timedOut and tree-kills', async () => {
    const results = await runVerificationCommands(
      ['node -e "setTimeout(() => {}, 5000)"'],
      {
        workspaceRoot: workspaceDir,
        timeoutMs: 300,
        maxOutputChars: 1000,
        signal: new AbortController().signal,
      },
    )

    expect(results).toHaveLength(1)
    const firstResult = results[0]!
    expect(firstResult.timedOut).toBe(true)
    expect(firstResult.outcome).toBe('failed')
  })

  // 12. Continuable child lost
  it('Scenario 12: continuable child missing throws explicit delegation error', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const subagents = createMockSubagents()
    subagents.sendMessage.mockRejectedValue(new Error('Child session not found in registry: c12'))
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
    })

    const parent = makeAgent('p12', workspaceDir)

    // Turn 1 ok
    const t1 = service.delegate({
      task: 'Turn 1',
      relevant_files: [],
      mode: 'continue',
      delegation_key: 'lost-child-key',
    }, { parent, signal: new AbortController().signal })

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalled())
    const calls12 = subagents.startContinuable.mock.calls
    expect(calls12.length).toBeGreaterThan(0)
    const prompt1 = calls12[0]![0].request.prompt[0].text
    const payload1 = parseContinuationHandoff(prompt1)
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: `Turn 1 done [DSH_CONTEXT_ACK: revision=${payload1.revision}]` }],
    })
    await t1

    // Turn 2: child lost
    await expect(service.delegate({
      task: 'Turn 2',
      relevant_files: [],
      mode: 'continue',
      delegation_key: 'lost-child-key',
    }, { parent, signal: new AbortController().signal })).rejects.toThrowError(/CODEX_DELEGATION_FAILED/)
  })

  // 13. Revision mismatch
  it('Scenario 13: model returning mismatched revision ACK triggers rollback', async () => {
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: workspaceDir, diffBasisMaxBytes: 100000 })
    const subagents = createMockSubagents()
    ctx.subagents = subagents as any
    const service = new ContextDelegationService(ctx, {
      continuationEnabled: true,
      continuationProviderName: 'spawn',
      requireContextAck: true,
    })

    const parent = makeAgent('p13', workspaceDir)

    const turn1Promise = service.delegate({
      task: 'Task expecting valid ACK',
      relevant_files: [],
      mode: 'continue',
      delegation_key: 'ack-mismatch-key',
    }, { parent, signal: new AbortController().signal })

    await vi.waitFor(() => expect(subagents.startContinuable).toHaveBeenCalled())

    // Emit with wrong / mismatched revision
    ctx.emit('subagent/end' as any, {
      id: 'child-1',
      provider: 'spawn',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'Done with bad ack [DSH_CONTEXT_ACK: revision=forged-revision-999]' }],
    })

    await expect(turn1Promise).rejects.toThrowError(/CONTEXT_REVISION_MISMATCH|ACK/)
  })
})
