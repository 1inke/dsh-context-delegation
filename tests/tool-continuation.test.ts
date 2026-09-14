import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyTool } from '../src/tool.ts'
import { apply as applyPreview } from '../src/preview.ts'
import { renderCodexExpertResult } from '../src/result.ts'
import type { DelegationResult } from '../src/types.ts'

function createEnvironment() {
  const ctx = new Context()
  const registeredTools = new Map<string, ToolDefinition>()
  const register = vi.fn((tool: ToolDefinition) => {
    registeredTools.set(tool.name, tool)
    return () => undefined
  })
  const delegate = vi.fn().mockResolvedValue({
    success: true,
    provider: 'spawn',
    workspaceRoot: '/workspace',
    contextFilesLoaded: ['AGENTS.md'],
    contextFilesMissing: [],
    contextFilesTruncated: [],
    contextChars: 100,
    runId: 'child-1',
    codexFinal: 'Done.',
    parentVerificationRequired: true,
    continuation: {
      reused: true,
      delegationKey: 'feature-1',
      contextMode: 'delta',
      revision: 'sha256:rev2',
      baseRevision: 'sha256:rev1',
      handoffBytes: 256,
    },
  })
  const preview = vi.fn().mockResolvedValue({
    task: 'Preview task',
    mode: 'lexical',
    totalChars: 100,
    maxContextChars: 40000,
    mandatory: [],
    retrieved: [],
    rejectedChunkCount: 0,
    missingFiles: [],
    sourceLimitedFiles: [],
    continuation: {
      reused: true,
      delegationKey: 'feature-1',
      contextMode: 'delta',
      revision: 'sha256:rev2',
      handoffBytes: 256,
    },
  })

  ctx.tools = { register } as any
  ctx.codexContextDelegation = {
    config: { toolName: 'codex_expert' },
    delegate,
    preview,
  } as any

  applyTool(ctx)
  applyPreview(ctx)

  return {
    expertTool: registeredTools.get('codex_expert')!,
    previewTool: registeredTools.get('context_preview')!,
    delegate,
    preview,
  }
}

function mockExecution() {
  return {
    agent: { session: { header: { cwd: '/workspace' } } },
    signal: new AbortController().signal,
  } as any
}

describe('tool and preview continuation schema and rendering', () => {
  it('exposes mode and delegation_key parameters in schema', () => {
    const { expertTool, previewTool } = createEnvironment()
    const expertProps = (expertTool.parameters as any).properties
    const previewProps = (previewTool.parameters as any).properties

    expect(expertProps).toHaveProperty('mode')
    expect(expertProps).toHaveProperty('delegation_key')
    expect(previewProps).toHaveProperty('mode')
    expect(previewProps).toHaveProperty('delegation_key')
  })

  it('rejects delegation_key when mode is fresh or omitted', async () => {
    const { expertTool } = createEnvironment()

    await expect(expertTool.execute({
      task: 'Task',
      delegation_key: 'key-1',
    }, mockExecution())).rejects.toThrowError(/delegation_key/)

    await expect(expertTool.execute({
      task: 'Task',
      mode: 'fresh',
      delegation_key: 'key-1',
    }, mockExecution())).rejects.toThrowError(/delegation_key/)
  })

  it('rejects mode: continue when delegation_key is missing', async () => {
    const { expertTool } = createEnvironment()

    await expect(expertTool.execute({
      task: 'Task',
      mode: 'continue',
    }, mockExecution())).rejects.toThrowError(/delegation_key/)
  })

  it('validates delegation_key regex pattern', async () => {
    const { expertTool } = createEnvironment()

    // Valid keys
    await expect(expertTool.execute({
      task: 'Task',
      mode: 'continue',
      delegation_key: 'valid-key.1_test',
    }, mockExecution())).resolves.toBeDefined()

    // Invalid keys
    await expect(expertTool.execute({
      task: 'Task',
      mode: 'continue',
      delegation_key: '-invalid-start',
    }, mockExecution())).rejects.toThrowError(/delegation_key/)

    await expect(expertTool.execute({
      task: 'Task',
      mode: 'continue',
      delegation_key: 'invalid with spaces',
    }, mockExecution())).rejects.toThrowError(/delegation_key/)

    await expect(expertTool.execute({
      task: 'Task',
      mode: 'continue',
      delegation_key: 'a'.repeat(65),
    }, mockExecution())).rejects.toThrowError(/delegation_key/)
  })

  it('renders continuation section in codex expert result', () => {
    const result: DelegationResult = {
      success: true,
      provider: 'spawn',
      workspaceRoot: '/workspace',
      contextFilesLoaded: ['AGENTS.md'],
      contextFilesMissing: [],
      contextFilesTruncated: [],
      contextChars: 100,
      runId: 'child-1',
      codexFinal: 'Implementation finished.',
      parentVerificationRequired: true,
      continuation: {
        reused: true,
        delegationKey: 'feature-auth',
        contextMode: 'delta',
        revision: 'sha256:abc',
        baseRevision: 'sha256:123',
        handoffBytes: 512,
      },
    }

    const rendered = renderCodexExpertResult(result)
    expect(rendered).toContain('## Continuation')
    expect(rendered).toContain('feature-auth')
    expect(rendered).toContain('reused')
    expect(rendered).toContain('delta')
    expect(rendered).toContain('512 bytes')
  })
})
