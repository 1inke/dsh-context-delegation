import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/preview.ts'
import { ContextDelegationService } from '../src/index.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'

describe('scoped read-only preview tool', () => {
  function setup(contextMode: 'lexical' | 'legacy' = 'lexical') {
    const ctx = new Context()
    const fs = new RecordingFileSystem(ctx)
    ctx.fs = fs
    fs.setDirectory('/workspace').setFile('/workspace/AGENTS.md', 'Do not write')
    const start = vi.fn()
    ctx.subagents = { start, getProvider: vi.fn(() => undefined) } as any
    const service = new ContextDelegationService(ctx, { contextMode })
    let tool: ToolDefinition | undefined
    ctx.tools = { register: vi.fn(value => { tool = value }) } as any
    apply(ctx)
    return { ctx, fs, service, start, tool: tool!, execution: {
      agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal,
    } as any }
  }
  it('works without any provider, registers only preview and renders valid JSON', async () => {
    const { tool, execution, start, ctx } = setup()
    expect(tool.name).toBe('context_preview')
    expect(ctx.tools.register).toHaveBeenCalledTimes(1)
    const result = await tool.execute({ task: 'Inspect rules' }, execution)
    expect(validateJsonSchemaValue(tool.output!.schema, result)).toEqual([])
    expect(JSON.parse(result as string)).toMatchObject({ totalChars: 12, retrieved: [],
      mandatory: [{ relativePath: 'AGENTS.md', chars: 12, truncated: false }] })
    expect(start).not.toHaveBeenCalled()
  })
  it('rejects model overrides and missing parent before any context read', async () => {
    const { tool, execution, fs } = setup()
    for (const field of ['provider', 'contextMode', 'contextBudgets', 'model', 'permission']) {
      await expect(tool.execute({ task: 'Inspect', [field]: 'override' }, execution)).rejects.toThrow('does not accept')
    }
    await expect(tool.execute({ task: 'Inspect' }, { signal: execution.signal } as any)).rejects.toThrow('[WORKSPACE_NOT_FOUND]')
    expect(fs.calls).toHaveLength(0)
  })
  it('retains legacy mode with the V1 handoff and serial context', async () => {
    const { service, execution, fs } = setup('legacy')
    fs.setFile('/workspace/harness/context/EXPERIMENTS.md', '# Unrelated\nkeep full legacy content')
    const prepared = await service.prepareContext({ task: 'Inspect' }, { parent: execution.agent, signal: execution.signal })
    expect(prepared.context.selection).toBeUndefined()
    expect(prepared.context.files.find(f => f.id === 'experiments')?.content).toContain('keep full legacy content')
  })
})
