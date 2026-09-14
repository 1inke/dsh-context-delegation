// Opt-in performance baseline (roadmap V0.8). Measures prepareContext via the
// read-only preview path on a synthetic multi-section context workspace:
//   - first (cold) call, cache enabled
//   - warm p50/p95 with the cache enabled
//   - warm p50/p95 with the cache disabled (separate service instance)
// Output: one JSON line with the baseline numbers. No provider, no network.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ContextDelegationService, clearChunkCache } from '../lib/index.js'

const SECTIONS = 120
const root = await mkdtemp(join(tmpdir(), 'dsh-v08-perf-'))
await mkdir(join(root, 'harness/context'), { recursive: true })
await writeFile(join(root, 'harness/context/AGENTS.md'), '# Agents\n\nBe safe and honest.\n')
await writeFile(join(root, 'harness/context/CURRENT_STATE.md'), '# Current State\n\nBaseline.\n')
await writeFile(join(root, 'harness/context/CODEX_HANDOFF.md'), '# Handoff Rules\n\nReport honestly.\n')
for (const [file, title] of [['PROJECT_CONTEXT.md', 'Project Context'], ['DECISIONS.md', 'Decisions'], ['EXPERIMENTS.md', 'Experiments']]) {
  const parts = [`# ${title}\n`]
  for (let index = 0; index < SECTIONS; index++) {
    parts.push(`\n## Section ${index} sampling\n\nSynthetic paragraph ${index} about non-uniform sampling, buckets, and determinism for a fixed seed. `)
    parts.push('Additional filler text with moderate length to exercise chunking and ranking paths.\n')
  }
  await writeFile(join(root, `harness/context/${file}`), parts.join(''))
}

const ctx = new Context()
new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
const parent = { id: 'perf', session: { id: 'perf', header: { cwd: root } } }
const execution = { parent, signal: new AbortController().signal }
const input = { task: 'non-uniform sampling preferred path', relevant_files: [] }

const cachedService = new ContextDelegationService(ctx, { providerName: 'spawn', cacheEnabled: true })
// A service registers one `codexContextDelegation` per context; the uncached
// baseline gets its own context sharing the same workspace files.
const ctx2 = new Context()
new LocalFileSystem(ctx2, { cwd: root, diffBasisMaxBytes: 100000 })
const uncachedService = new ContextDelegationService(ctx2, { providerName: 'spawn', cacheEnabled: false })

const preview = service => service.preview(input, execution)
const percentile = (values, ratio) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

const report = {}
await preview(cachedService)
const cachedTimings = []
for (let index = 0; index < 30; index++) {
  const start = performance.now()
  await preview(cachedService)
  cachedTimings.push(performance.now() - start)
}
report.warmCachedP50Ms = Number(percentile(cachedTimings, 0.5).toFixed(2))
report.warmCachedP95Ms = Number(percentile(cachedTimings, 0.95).toFixed(2))
const coldTimings = []
for (let index = 0; index < 3; index++) {
  clearChunkCache()
  const start = performance.now()
  await preview(cachedService)
  coldTimings.push(performance.now() - start)
}
report.coldMs = Number(percentile(coldTimings, 0.5).toFixed(2))
const uncachedTimings = []
for (let index = 0; index < 30; index++) {
  const start = performance.now()
  await preview(uncachedService)
  uncachedTimings.push(performance.now() - start)
}
report.warmUncachedP50Ms = Number(percentile(uncachedTimings, 0.5).toFixed(2))
report.warmUncachedP95Ms = Number(percentile(uncachedTimings, 0.95).toFixed(2))
const lastPreview = await preview(cachedService)
report.selectedContextChars = lastPreview.totalChars
report.selectedChunks = lastPreview.retrieved.length
report.sectionsPerFile = SECTIONS

async function mkdir(path) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })
}
await rm(root, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
