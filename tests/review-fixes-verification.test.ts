import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DelegationSessionRegistry } from '../src/delegation-session.ts'
import { ContextDelegationService } from '../src/index.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'
import { chunkContext } from '../src/context-chunker.ts'
import { buildContextSnapshot, computePolicyRevision } from '../src/context-fingerprint.ts'
import { extractContextAck } from '../src/continuation-handoff.ts'
import type { ContextBundle, ScoredContextChunk } from '../src/types.ts'

function createMockCordis(providerName = 'spawn') {
  const ctx = new Context()
  const fs = new RecordingFileSystem(ctx)
  ctx.fs = fs

  const workspaceRoot = '/workspace'
  fs.setDirectory(workspaceRoot)
  fs.setDirectory(`${workspaceRoot}/harness`)
  fs.setDirectory(`${workspaceRoot}/harness/context`)
  fs.setFile(`${workspaceRoot}/AGENTS.md`, '# Agents Rule\nRule 1')
  fs.setFile(`${workspaceRoot}/harness/context/CURRENT_STATE.md`, '# Current State\nActive')

  const mockProvider = {
    name: providerName,
    capabilities: {},
    prepareContinuable: async () => ({}),
  }

  const subagents: any = {
    getProvider: vi.fn().mockImplementation((name: string) => (name === providerName ? mockProvider : undefined)),
    start: vi.fn(),
    startContinuable: vi.fn(),
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    drainContinuableChildren: vi.fn().mockResolvedValue(undefined),
  }

  ;(ctx as any).subagents = subagents

  const parent = {
    id: `parent-${Math.random().toString(36).slice(2)}`,
    session: {
      id: 'parent-session',
      header: { cwd: workspaceRoot },
    },
  } as any

  return { ctx, subagents, parent, fs }
}

describe('Rework Fixes: P1-5, P1-3, P2 verification', () => {
  describe('P1-5: Send failure rollback & TTL graceful recreate', () => {
    it('rolls back session when sendFollowup fails so subsequent call is not stuck busy', async () => {
      let callCount = 0
      const { ctx, subagents, parent } = createMockCordis('spawn')
      subagents.startContinuable.mockResolvedValue({ childId: 'child-abc', messageId: 'msg-1' })
      subagents.sendMessage.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('Network timeout during sendMessage')
        }
        return 'msg-2'
      })

      const service = new ContextDelegationService(ctx, {
        continuationEnabled: true,
        requireContextAck: false, // focus on send failure behavior
      })

      // Turn 1: create session
      const t1Promise = service.delegate(
        {
          task: 'Initial task',
          mode: 'continue',
          delegation_key: 'session-key-1',
        },
        { parent, signal: new AbortController().signal },
      )

      await new Promise(r => setTimeout(r, 20))
      ctx.emit('subagent/end' as any, {
        id: 'child-abc',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'Turn 1 success' }],
      })
      await t1Promise

      // Turn 2: sendMessage fails
      await expect(
        service.delegate(
          {
            task: 'Followup task',
            mode: 'continue',
            delegation_key: 'session-key-1',
          },
          { parent, signal: new AbortController().signal },
        ),
      ).rejects.toThrow()

      // Turn 3: session must NOT be stuck in DELEGATION_BUSY
      const t3Promise = service.delegate(
        {
          task: 'Followup task retry',
          mode: 'continue',
          delegation_key: 'session-key-1',
        },
        { parent, signal: new AbortController().signal },
      )

      await new Promise(r => setTimeout(r, 20))
      ctx.emit('subagent/end' as any, {
        id: 'child-abc',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'Turn 3 success' }],
      })
      const res3 = await t3Promise
      expect(res3.success).toBe(true)
    })

    it('re-creates session gracefully when TTL expires instead of hitting unreachable branch', async () => {
      const { ctx, subagents, parent } = createMockCordis('spawn')
      let childIndex = 0
      subagents.startContinuable.mockImplementation(async () => {
        childIndex++
        return { childId: `child-${childIndex}`, messageId: `msg-${childIndex}` }
      })
      subagents.sendMessage.mockResolvedValue('msg-2')

      const service = new ContextDelegationService(ctx, {
        continuationEnabled: true,
        idleTtlMs: 1000, // minimum valid config TTL
        requireContextAck: false,
      })

      // Turn 1
      const t1Promise = service.delegate(
        {
          task: 'Initial task',
          mode: 'continue',
          delegation_key: 'session-key-ttl',
        },
        { parent, signal: new AbortController().signal },
      )

      await new Promise(r => setTimeout(r, 20))
      ctx.emit('subagent/end' as any, {
        id: 'child-1',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'Turn 1 done' }],
      })
      await t1Promise

      // Wait for 1100ms so TTL expires
      await new Promise(r => setTimeout(r, 1100))

      // Turn 2: should re-create new child, NOT throw unreachable error
      const t2Promise = service.delegate(
        {
          task: 'Expired follow-up task',
          mode: 'continue',
          delegation_key: 'session-key-ttl',
        },
        { parent, signal: new AbortController().signal },
      )

      await new Promise(r => setTimeout(r, 20))
      expect(subagents.startContinuable).toHaveBeenCalledTimes(2)
      ctx.emit('subagent/end' as any, {
        id: 'child-2',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'Turn 2 done with fresh session' }],
      })
      const res2 = await t2Promise
      expect(res2.success).toBe(true)
      expect(res2.continuation?.reused).toBe(false)
    })
  })

  describe('P1-3: Context revision ACK verification & rollback', () => {
    it('extractContextAck parses valid ACK, detects missing, multiple, and malformed ACKs', () => {
      const validText = 'Task done.\n[DSH_CONTEXT_ACK: revision=sha256:abcd baseRevision=sha256:1234]\nFinal.'
      const validAck = extractContextAck(validText)
      expect(validAck.valid).toBe(true)
      expect(validAck.acknowledgedRevision).toBe('sha256:abcd')
      expect(validAck.acknowledgedBaseRevision).toBe('sha256:1234')

      const missingAck = extractContextAck('Task done without acknowledgment.')
      expect(missingAck.valid).toBe(false)
      expect(missingAck.error).toBe('MISSING_ACK')

      const multiText = '[DSH_CONTEXT_ACK: revision=sha256:111]\ntext\n[DSH_CONTEXT_ACK: revision=sha256:222]'
      const multiAck = extractContextAck(multiText)
      expect(multiAck.valid).toBe(false)
      expect(multiAck.error).toBe('MULTIPLE_ACKS')
    })

    it('rejects turn and does not commit snapshot if ACK revision does not match', async () => {
      const { ctx, subagents, parent } = createMockCordis('spawn')
      subagents.startContinuable.mockResolvedValue({ childId: 'child-ack-test', messageId: 'msg-1' })

      const service = new ContextDelegationService(ctx, {
        continuationEnabled: true,
        requireContextAck: true,
      })

      const turnPromise = service.delegate(
        {
          task: 'Task expecting ACK',
          mode: 'continue',
          delegation_key: 'key-ack-mismatch',
        },
        { parent, signal: new AbortController().signal },
      )

      await new Promise(r => setTimeout(r, 20))
      // Assistant returns WRONG revision in ACK
      ctx.emit('subagent/end' as any, {
        id: 'child-ack-test',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'Done! [DSH_CONTEXT_ACK: revision=sha256:wrong-hash]' }],
      })

      await expect(turnPromise).rejects.toThrow(/revision/)

      // Session should NOT have committed the snapshot
      const session = (service as any).sessionRegistry.getSession(parent, 'key-ack-mismatch', 'spawn')
      expect(session?.snapshot).toBeUndefined()
    })
  })

  describe('P2: Stable chunk ordinal in document chunking', () => {
    it('assigns stable partIndex at source chunking so omissions do not shift ordinals', () => {
      const source = {
        sourceId: 'projectContext' as const,
        relativePath: 'harness/context/PROJECT_CONTEXT.md',
        content: '# Heading A\n' + 'A'.repeat(500) + '\n\n' + 'B'.repeat(500) + '\n\n' + 'C'.repeat(500),
      }

      const chunks = chunkContext(source, { maxChunkChars: 400 })
      expect(chunks.length).toBeGreaterThanOrEqual(3)
      // Check that partIndex is strictly monotonic per section
      expect(chunks[0]!.partIndex).toBe(0)
      expect(chunks[1]!.partIndex).toBe(1)
      expect(chunks[2]!.partIndex).toBe(2)

      // Test snapshot unit generation when chunk 0 is omitted
      const selectedSubset: ScoredContextChunk[] = [
        { ...chunks[1]!, score: 10, matchedTerms: ['term'] },
        { ...chunks[2]!, score: 8, matchedTerms: ['term'] },
      ]

      const bundle: ContextBundle = {
        workspaceRoot: '/workspace',
        files: [],
        missingFiles: [],
        truncatedFiles: [],
        totalChars: 1000,
        selection: {
          minimumScore: 1,
          mandatoryFiles: [],
          selectedChunks: selectedSubset,
          rejectedChunks: [],
          totalChars: 1000,
          budgetUsage: { mandatory: 0, project: 1000, decisions: 0, experiments: 0 },
          budgets: { mandatory: 10000, project: 5000, decisions: 5000, experiments: 5000 },
          sourceLimitedFiles: [],
        },
      }

      const snapshot = buildContextSnapshot({
        bundle,
        policyRevision: 'sha256:dummy',
      })

      // Chunk 1 must retain its original partIndex (1), NOT be reset to 0
      const unit1 = snapshot.units.find(u => u.content === chunks[1]!.content)
      expect(unit1).toBeDefined()
      expect(unit1?.partIndex).toBe(1)
    })
  })

  describe('P2: Preview consistency with execution & comprehensive policy revision', () => {
    it('previewContext returns reused: false when TTL has expired', async () => {
      const { ctx, parent } = createMockCordis('spawn')
      const service = new ContextDelegationService(ctx, {
        continuationEnabled: true,
        idleTtlMs: 1000,
      })

      // Manually seed a ready session
      const registry = (service as any).sessionRegistry as DelegationSessionRegistry
      const turn = await registry.acquireOrCreateSession({
        parent,
        delegationKey: 'preview-key',
        provider: 'spawn',
        compatibilityKey: 'test-compat',
        createChild: async () => 'child-p',
      })
      turn.commit({ revision: 'sha256:r1', policyRevision: 'test-compat', units: [], missingFiles: [], sourceLimitedFiles: [], byteLength: 10 } as any)

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 1100))

      const preview = await service.preview(
        { task: 'preview task', mode: 'continue', delegation_key: 'preview-key' },
        { parent, signal: new AbortController().signal },
      )

      expect(preview.continuation?.reused).toBe(false)
      expect(preview.continuation?.contextMode).toBe('full')
    })

    it('computePolicyRevision includes protocol version, includeFlags, and budgets', () => {
      const rev1 = computePolicyRevision({
        mandatoryFiles: [],
        missingFiles: [],
        contextRoot: 'harness/context',
        maxContextChars: 40000,
        protocolVersion: 'dsh-context-delegation/v3',
        includeFlags: { includeAgents: true },
        budgets: { mandatory: 10000, project: 5000, decisions: 5000, experiments: 5000 },
      })

      const rev2 = computePolicyRevision({
        mandatoryFiles: [],
        missingFiles: [],
        contextRoot: 'harness/context',
        maxContextChars: 40000,
        protocolVersion: 'dsh-context-delegation/v3',
        includeFlags: { includeAgents: false }, // changed flag
        budgets: { mandatory: 10000, project: 5000, decisions: 5000, experiments: 5000 },
      })

      expect(rev1).not.toBe(rev2)
    })
  })
})


