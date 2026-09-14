// Opt-in integration harness. Uses the official DSH registry/provider/process
// services and existing Codex authentication; never reads or copies credentials.
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ContextDelegationService } from '../lib/index.js'

const dsh = process.argv[2]
if (!dsh) throw new Error('Usage: node scripts/live-codex-smoke.mjs <DSH checkout>')
const load = path => import(pathToFileURL(resolve(dsh, path)).href)
const { default: SessionProjectionRegistry } = await load('packages/session/session-projection/lib/index.js')
const { default: LocalSubprocessRuntime } = await load('packages/subprocess/subprocess-local/lib/index.js')
const codex = await load('packages/subagent/subagent-codex/lib/index.js')
const workspace = resolve(import.meta.dirname, '../tests/fixtures/retrieval-project')
async function snapshot() {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true })
  return Promise.all(entries.filter(e => e.isFile()).map(async entry => {
    const path = join(entry.parentPath, entry.name)
    return [path, createHash('sha256').update(await readFile(path)).digest('hex')]
  })).then(values => values.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
const before = await snapshot()
const ctx = new Context()
const handles = []
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 120000)
let report
try {
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 100000 })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => { const handle = spawn(spec); handles.push(handle); return handle }
  await ctx.plugin(codex, { model: 'gpt-5.6-luna', permissionMode: 'never', env: {}, disposeGraceMs: 2000 })
  const service = new ContextDelegationService(ctx)
  const execution = { parent: { id: 'v02-smoke-parent', session: { header: { cwd: workspace } } }, signal: controller.signal }
  const input = {
    task: 'Read-only validation: Using only supplied AV2 non-uniform sampling context, identify the preferred sampling path from decisions. Do not run tools or modify files. Include V02_CONTEXT_SMOKE_OK and the preferred path in the final response; report that no changes or tests were performed.',
    relevant_files: ['src/av2/sampling.ts'],
  }
  const preview = await service.preview(input, execution)
  const result = await service.delegate(input, execution)
  const unchanged = JSON.stringify(await snapshot()) === JSON.stringify(before)
  const quiescent = (await Promise.all(handles.map(handle => handle.waitForExit()))).every(Boolean)
  const relevantOnly = !preview.retrieved.some(chunk => /Packaging|SDD|Authentication|Typography|Cache|Localization|Compression|Migration|Rendering/.test(chunk.headingPath.join(' ')))
  const correct = relevantOnly && result.codexFinal.includes('V02_CONTEXT_SMOKE_OK') && /weighted[ -]bucket/i.test(result.codexFinal)
  report = { status: correct && unchanged && quiescent ? 'PASS' : 'FAIL',
    provider: result.provider, model: 'gpt-5.6-luna', runId: result.runId,
    contextChars: result.contextChars, selectedHeadings: preview.retrieved.map(c => c.headingPath),
    unchanged, quiescent, relevantOnly, ownedProcessCount: handles.length, final: result.codexFinal }
} catch (error) {
  report = { status: 'FAIL', code: error.code ?? null, message: error.message,
    unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before) }
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  await ctx.fiber.dispose()
  report.quiescent = (await Promise.all(handles.map(handle => handle.waitForExit()))).every(Boolean)
  report.ownedProcessCount = handles.length
}
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'PASS') process.exitCode = 1
