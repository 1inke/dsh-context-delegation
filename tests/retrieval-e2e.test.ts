import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ContextDelegationService, HANDOFF_PAYLOAD_V2_BEGIN, HANDOFF_PAYLOAD_V2_END } from '../src/index.ts'
import { apply as applyPreview } from '../src/preview.ts'
import { apply as applyExpert } from '../src/tool.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

describe('retrieval fixture: real FS to model-facing tools to provider boundary', () => {
  it('rejects weak incidental matches in a verbose real smoke task', async () => {
    const root = resolve(import.meta.dirname, 'fixtures/retrieval-project')
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
    const service = new ContextDelegationService(ctx)
    const preview = await service.preview({
      task: 'Read-only validation: Using only supplied AV2 non-uniform sampling context, identify the preferred sampling path from decisions. Do not run tools or modify files. Include V02_CONTEXT_SMOKE_OK and the preferred path in the final response; report that no changes or tests were performed.',
      relevant_files: ['src/av2/sampling.ts'],
    }, { parent: { session: { header: { cwd: root } } } as any, signal: new AbortController().signal })
    expect(preview.retrieved.map(c => c.headingPath.join(' > ')).join('\n')).not.toMatch(/Packaging|SDD|Authentication|Typography|Cache|Localization|Compression|Migration|Rendering/)
    expect(preview.retrieved.some(c => c.headingPath.includes('AV2 Sampling Evidence'))).toBe(true)
    expect(preview.retrieved.some(c => c.headingPath.includes('Non-uniform Sampling'))).toBe(true)
  })
  it('selects AV2 and excludes distractors, sends identical preview selection and leaves files unchanged', async () => {
    const root = resolve(import.meta.dirname, 'fixtures/retrieval-project')
    const paths = ['AGENTS.md', ...['CURRENT_STATE', 'CODEX_HANDOFF', 'PROJECT_CONTEXT', 'DECISIONS', 'EXPERIMENTS'].map(name => `harness/context/${name}.md`)]
    const hash = async () => Promise.all(paths.map(async path => createHash('sha256').update(await readFile(join(root, path))).digest('hex')))
    const before = await hash()
    const ctx = new Context()
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
    const dispose = vi.fn()
    const start = vi.fn(async () => ({ id: 'fixture-run', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'FIXTURE_OK' }] }), dispose }))
    ctx.subagents = { getProvider: vi.fn(() => ({})), start } as any
    new ContextDelegationService(ctx)
    const tools: ToolDefinition[] = []
    ctx.tools = { register: (tool: ToolDefinition) => { tools.push(tool) } } as any
    applyExpert(ctx)
    applyPreview(ctx)
    const input = { task: 'Fix AV2 non-uniform sampling behavior.', relevant_files: ['src/av2/sampling.ts'] }
    const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal } as any
    const preview = JSON.parse(await tools.find(t => t.name === 'context_preview')!.execute(input, exec) as string)
    expect(start).not.toHaveBeenCalled()
    expect(preview.retrieved.length).toBeGreaterThanOrEqual(3)
    const headings = preview.retrieved.flatMap((c: any) => c.headingPath).join(' ')
    expect(headings).toContain('AV2 Sampling')
    expect(headings).toContain('Non-uniform Sampling')
    expect(headings).not.toMatch(/SDD|Packaging|Cache|Authentication|Typography/)
    await tools.find(t => t.name === 'codex_expert')!.execute(input, exec)
    expect(start).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    const prompt = (start.mock.calls as any)[0][1].prompt[0].text as string
    const payload = JSON.parse(prompt.split(HANDOFF_PAYLOAD_V2_BEGIN + '\n')[1]!.split('\n' + HANDOFF_PAYLOAD_V2_END)[0]!)
    const chunks = payload.sections.flatMap((s: any) => s.value?.chunks ?? [])
    expect(chunks.map((c: any) => [c.relativePath, c.headingPath, c.score]).sort())
      .toEqual(preview.retrieved.map((c: any) => [c.relativePath, c.headingPath, c.score]).sort())
    expect(await hash()).toEqual(before)
  })
})
