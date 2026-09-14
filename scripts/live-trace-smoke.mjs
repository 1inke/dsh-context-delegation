// Opt-in real-runtime observability smoke (V0.7 evidence).
//
// Runs the same reviewed + write-back flow as live-writeback-smoke.mjs and
// additionally asserts that the process-local DelegationTrace recorded the
// full stage timeline (context, executor, evidence, verification, review,
// write-back) with a finished outcome and a context revision fingerprint.
// Traces are metadata-only by contract: no executor transcripts, no
// verification output, no reasoning.
//
// Assembles the official DSH runtime plugins from the harness checkout (same
// single-cordis composition as live-continuation-smoke.mjs plus the fs write
// tools), creates a REAL live parent Agent and a throwaway git workspace, and
// runs the V0.4 reviewed delegation loop end to end:
//   executor (fresh, spawn) writes a file
//   -> plugin collects workspace evidence via git
//   -> plugin independently executes the caller-authorized verification command
//   -> reviewer (FRESH one-shot child, same provider) returns a structured verdict
//
// The LLM route is the operator's own declared provider (gemini-cpa); the key
// is read from the managed credentials document into the process environment
// only and never printed. The throwaway workspace and its git history live in
// the OS temp dir and are removed afterwards.
//
// Usage: node scripts/live-routing-smoke.mjs [DSH checkout]
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ContextDelegationService, recentDelegationTraces } from '../lib/index.js'

const harness = resolve(import.meta.dirname, process.argv[2] ?? '../../deepseek-harness')
const load = path => import(pathToFileURL(resolve(harness, path)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const { LocalFileSystem } = await load('packages/fs/fs-local/lib/index.js')
const { default: LlmService } = await load('packages/llm/llm/lib/index.js')
const { default: SubagentRuntime } = await load('packages/subagent/subagent/lib/index.js')
const { default: AgentRegistry, installModelSelection } = await load('packages/core/agent/lib/index.js')
const { default: SessionStore } = await load('packages/core/session/lib/index.js')
const { default: AgentDefaultModel } = await load('packages/core/agent-default-model/lib/index.js')
const { default: SystemPrompt } = await load('packages/core/system-prompt/lib/index.js')
const { default: ToolRuntime } = await load('packages/core/tools/lib/index.js')
const { default: AgentLoop } = await load('packages/core/agent-loop/lib/index.js')
const { default: DeepseekLlmApiExtensions } = await load('packages/llm/deepseek-llm-api-extensions/lib/index.js')
const LlmRetry = await load('packages/llm/llm-retry/lib/index.js')
const PiAi = await load('packages/llm/llm-pi-ai/lib/index.js')
const SessionLogDeepseek = await load('packages/session/session-log-deepseek/lib/index.js')
const { default: JsonlSessionPersistence } = await load('packages/session/session-persistence-jsonl/lib/index.js')
const { default: SqliteSessionQuery } = await load('packages/session-query/session-query-sqlite/lib/index.js')
const { default: SessionProjectionRegistry } = await load('packages/session/session-projection/lib/index.js')
const SpawnInProcess = await load('packages/subagent/subagent-spawn-in-process/lib/index.js')
const ToolFs = await load('packages/fs/tool-fs/lib/index.js')

const MODEL = 'gemini-3.8-flash-high'
const PROVIDER = 'gemini-cpa'
const MARKER = 'V04_REVIEW_SMOKE_OK'
const exec = promisify(execFile)

const credPath = process.env.DSH_CREDENTIALS_PATH || join(homedir(), '.dsh/.credentials.yaml')
const credText = await readFile(credPath, 'utf8')
const credMatch = credText.match(/^\s{2}GEMINI_CPA_API_KEY:\s*(.+?)\s*$/m)
if (!credMatch) throw new Error('GEMINI_CPA_API_KEY ref not found in the managed credentials document')
process.env.GEMINI_CPA_API_KEY = credMatch[1].replace(/^["']|["']$/g, '')

const root = await mkdtemp(join(tmpdir(), 'dsh-v04-review-smoke-'))
await exec('git', ['init', '-b', 'main'], { cwd: root })
await exec('git', ['config', 'user.email', 'smoke@example.test'], { cwd: root })
await exec('git', ['config', 'user.name', 'smoke'], { cwd: root })
await mkdir(join(root, 'harness/context'), { recursive: true })
await writeFile(join(root, 'harness/context/AGENTS.md'), '# Agents\n\nBe safe and honest.\n')
await writeFile(join(root, 'harness/context/CURRENT_STATE.md'), '# Current State\n\nNo answer file yet.\n')
await writeFile(join(root, 'harness/context/CODEX_HANDOFF.md'), '# Handoff Rules\n\nReport honestly with the executor report fence.\n')
await writeFile(join(root, 'harness/context/DECISIONS.md'), '# Decisions\n\n## Baseline decision\n\nThe baseline holds.\n')
await writeFile(join(root, 'widget.ts'), 'export const color = "blue"\n')
await exec('git', ['add', '.'], { cwd: root })
await exec('git', ['commit', '-m', 'baseline'], { cwd: root })

const baselineHashes = new Map()
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && !entry.name.endsWith('.output')) {
    const path = join(entry.parentPath ?? entry.path, entry.name)
    baselineHashes.set(path, createHash('sha256').update(await readFile(path)).digest('hex'))
  }
}

const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-v04-review-smoke-persist-'))
const ctx = new Context()
const t0 = Date.now()
const subagentStarts = []
ctx.on('subagent/start', info => {
  subagentStarts.push({ id: String(info.id), atMs: Date.now() - t0 })
})

const report = { status: 'FAIL' }
const globalController = new AbortController()
const watchdog = setTimeout(() => globalController.abort(new Error('smoke watchdog (300s)')), 300000)
try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentDefaultModel, { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' })
  await ctx.plugin(LlmService)
  await ctx.plugin(DeepseekLlmApiExtensions)
  await ctx.plugin(LlmRetry)
  await ctx.plugin(PiAi, {
    providers: {
      [PROVIDER]: {
        displayName: 'Gemini via CPA (live review smoke)',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:8317/v1',
        apiKeyEnv: 'GEMINI_CPA_API_KEY',
        models: [{
          id: MODEL,
          name: 'Gemini 3.8 Flash',
          reasoningEfforts: { medium: 'medium', high: 'high' },
          compat: { supportsReasoningEffort: true },
        }],
      },
    },
  })
  await ctx.plugin(SessionLogDeepseek)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
  await ctx.plugin(SqliteSessionQuery, { path: ':memory:', openAt: 'never' })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  await ctx.plugin(SpawnInProcess, { providerName: 'native-impl' })
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn-reviewer' })
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
  await ctx.plugin(ToolFs)

  const Driver = {
    inject: ['agents', 'subagents', 'sessionProjections', 'sessions', 'llm', 'tools', 'systemPrompt', 'fs'],
    async apply(driverCtx) {
      const service = new ContextDelegationService(driverCtx, {
        continuationEnabled: false,
        maxReviewRounds: 1,
        contextWriteback: 'apply',
        executorRouting: {
          implementation: { provider: 'spawn' },
          reviewer: { provider: 'spawn' },
        },
      })
      const selection = { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' }
      const { agent: parent } = await driverCtx.agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: root },
        agentOptions: selection,
        setup: agentCtx => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
        },
      })
      await parent.whenIdle()
      report.parentSessionId = parent.id

      const started = Date.now()
      let reviewerTexts = []
      const rawStart = driverCtx.subagents.start.bind(driverCtx.subagents)
      driverCtx.subagents.start = async (providerName, request) => {
        const run = await rawStart(providerName, request)
        if (request.label === 'Independent review') {
          run.result.then(settlement => {
            reviewerTexts.push((settlement.output ?? []).filter(b => b.type === 'text').map(b => b.text).join(''))
          }).catch(() => {})
        }
        return run
      }
      report.reviewerTexts = reviewerTexts
      const result = await service.delegate({
        task: 'Create a file named answer.txt in the workspace root whose entire content is exactly '
          + MARKER
          + ' (no trailing spaces). Use the filesystem write tool. Then, in your executor report, propose ONE decision entry titled "Record the answer file" with a rationale explaining that the answer file protocol was established and verified. Then report with the required executor report fence.',
        relevant_files: [],
        acceptance_criteria: [
          'answer.txt exists in the workspace root',
          'answer.txt content is exactly ' + MARKER,
        ],
        verification_commands: [
          `node -e "const fs=require('fs');const t=fs.readFileSync('answer.txt','utf8').trim();process.exit(t==='${MARKER}'?0:1)"`,
        ],
      }, { parent, signal: globalController.signal })
      report.ms = Date.now() - started
      report.review = result.review
      report.provider = result.provider
      report.routedImplementationProvider = result.provider
      report.contextWriteback = result.contextWriteback
    },
  }
  await ctx.plugin(Driver)

  const answerPath = join(root, 'answer.txt')
  let answerContent = null
  try {
    answerContent = (await readFile(answerPath, 'utf8')).trim()
  } catch {}
  report.answerContent = answerContent
  report.baselineFilesUnchanged = true
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith('.output')) {
      const path = join(entry.parentPath ?? entry.path, entry.name)
      if (!baselineHashes.has(path) && !path.endsWith('answer.txt') && !path.endsWith('DECISIONS.md')) report.baselineFilesUnchanged = false
    }
  }
  const review = report.review ?? {}
  let decisionsContent = null
  try {
    decisionsContent = await readFile(join(root, 'harness/context/DECISIONS.md'), 'utf8')
  } catch {}
  const writeback = report.contextWriteback ?? {}
  const trace = recentDelegationTraces().at(-1)
  report.trace = trace
  report.decisionsAfter = decisionsContent
  const checks = {
    reviewOutcomeCompleted: review.outcome === 'completed',
    executorReportCompleted: review.finalExecutorReport?.status === 'completed',
    evidenceObservedNewFile: review.workspaceEvidence?.filesChanged?.includes('answer.txt') === true,
    verificationPassed: review.verification?.[0]?.outcome === 'passed',
    answerContentExact: answerContent === MARKER,
    reviewerRanOnce: review.reviews?.length === 1 && review.reviews[0]?.verdict === 'pass',
    writebackApplied: writeback.status === 'applied',
    decisionWritten: decisionsContent !== null && decisionsContent.includes('Record the answer file') && decisionsContent.includes('## Baseline decision'),
    fingerprintAdvanced: typeof writeback.fingerprintBefore === 'string' && typeof writeback.fingerprintAfter === 'string'
      && writeback.fingerprintBefore !== writeback.fingerprintAfter,
    baselineFilesUnchanged: report.baselineFilesUnchanged === true,
    traceRecorded: trace !== undefined
      && trace.outcome === 'completed'
      && trace.finishedAt >= trace.startedAt
      && ['context', 'executor-start', 'executor-end', 'evidence', 'verification', 'review', 'write-back']
        .every(stage => trace.events.some(event => event.stage === stage))
      && typeof trace.contextRevision === 'string' && trace.contextRevision.length > 0,
    traceMetadataOnly: (() => {
      // taskId legitimately carries the parent-authored task prefix; strip it
      // before scanning for leaked executor/decision payload text.
      const withoutTask = JSON.stringify(recentDelegationTraces().map(t => ({ ...t, taskId: '' })))
      return !withoutTask.includes(MARKER) && !withoutTask.includes('The answer file protocol')
    })(),
  }
  report.checks = checks
  report.status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message ?? String(error), stack: error.stack?.split('\n').slice(0, 8) }
} finally {
  clearTimeout(watchdog)
  try { await ctx.fiber.dispose() } catch (error) { report.disposeError = String(error) }
  await rm(root, { recursive: true, force: true })
  await rm(persistenceRoot, { recursive: true, force: true })
}
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'PASS') process.exitCode = 1
