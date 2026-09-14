// Opt-in real-runtime continuation harness (V0.3-B evidence).
//
// Assembles the official DSH runtime plugins from the harness checkout
// (LLM registry, pi-ai declared provider, JSONL session persistence,
// agent registry + agent loop, subagent registry, spawn in-process provider),
// creates a REAL live parent Agent, and drives three real continuation turns
// through ContextDelegationService:
//   turn 1  mode=continue, new key  -> continuable child + full handoff + ACK
//   turn 2  mode=continue, same key -> reuse + delta handoff + revision ACK
//   turn 3  aborted mid-flight      -> CODEX_CANCELLED + bounded quiescence
//
// The whole flow runs inside a driver plugin that declares the same service
// injects the real host plane uses: agent creation and subagent orchestration
// validate cordis accessor reads against the calling plugin's inject list, so
// driving from the bare root context is not equivalent to a real composition.
//
// The child LLM route is the operator's own declared provider (gemini-cpa)
// exactly as configured in the user's DSH settings; the key is read from the
// user's managed credentials document into the process environment only and
// is never printed or persisted. The read-only workspace must be
// byte-identical on files after the run; the persistence scratch root is
// removed afterwards.
//
// Usage: node scripts/live-continuation-smoke.mjs [DSH checkout]
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ContextDelegationService } from '../lib/index.js'

const harness = resolve(import.meta.dirname, process.argv[2] ?? '../../deepseek-harness')
const load = path => import(pathToFileURL(resolve(harness, path)).href)

// Use the harness's own (vendored) cordis instance so the whole runtime shares
// ONE cordis world; only the plugin's own service comes from the plugin build
// (its Service base symbols are Symbol.for-registered and therefore shared).
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

const MODEL = 'gemini-3.8-flash-high'
const PROVIDER = 'gemini-cpa'
const KEY = 'v03-live-smoke'

const credPath = process.env.DSH_CREDENTIALS_PATH || join(homedir(), '.dsh/.credentials.yaml')
const credText = await readFile(credPath, 'utf8')
const credMatch = credText.match(/^\s{2}GEMINI_CPA_API_KEY:\s*(.+?)\s*$/m)
if (!credMatch) throw new Error('GEMINI_CPA_API_KEY ref not found in the managed credentials document')
process.env.GEMINI_CPA_API_KEY = credMatch[1].replace(/^["']|["']$/g, '')

const workspace = resolve(import.meta.dirname, '../tests/fixtures/retrieval-project')
async function snapshot() {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true })
  return Promise.all(entries.filter(e => e.isFile()).map(async entry => {
    const path = join(entry.parentPath, entry.name)
    return [path, createHash('sha256').update(await readFile(path)).digest('hex')]
  })).then(values => values.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
const before = await snapshot()
const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-v03-live-smoke-'))

const ctx = new Context()
const report = { status: 'FAIL', turns: [], workspaceUnchanged: false, persistenceFiles: 0, childStarts: [] }
const globalController = new AbortController()
const watchdog = setTimeout(() => globalController.abort(new Error('smoke watchdog (300s)')), 300000)
const t0 = Date.now()
ctx.on('subagent/start', info => {
  report.childStarts.push({ id: String(info.id), runId: info.runId ? String(info.runId) : undefined, atMs: Date.now() - t0 })
})

/** Host-plane equivalent driver: same accessor allowances a real composition grants. */
const Driver = {
  inject: ['agents', 'subagents', 'sessionProjections', 'sessions', 'llm', 'tools', 'systemPrompt', 'fs'],
  async apply(driverCtx) {
    const service = new ContextDelegationService(driverCtx, {
      providerName: 'spawn',
      continuationEnabled: true,
      continuationProviderName: 'spawn',
      requireContextAck: true,
      maxSessions: 4,
      idleTtlMs: 300000,
    })

    const selection = { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' }
    const { agent: parent } = await driverCtx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: workspace },
      agentOptions: selection,
      setup: agentCtx => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })
    await parent.whenIdle()
    report.parentSessionId = parent.id

    const turnSignal = () => {
      const controller = new AbortController()
      if (globalController.signal.aborted) controller.abort(globalController.signal.reason)
      else globalController.signal.addEventListener('abort', () => controller.abort(globalController.signal.reason), { once: true })
      return controller.signal
    }
    const relevant = ['src/av2/sampling.ts']

    // Turn 1: new key -> continuable child + full handoff.
    {
      const signal = turnSignal()
      const started = Date.now()
      const r1 = await service.delegate({
        task: 'Read-only validation using only the supplied context: name the preferred sampling path from the decisions context, then state which sampling family it belongs to. Do not run tools or modify files. Include the exact marker V03_CONT_SMOKE_T1 in your final response.',
        relevant_files: relevant,
        mode: 'continue',
        delegation_key: KEY,
      }, { parent, signal })
      report.turns.push({
        turn: 1, ms: Date.now() - started, provider: r1.provider, workspaceRoot: r1.workspaceRoot,
        contextChars: r1.contextChars, continuation: r1.continuation,
        markerOk: r1.codexFinal.includes('V03_CONT_SMOKE_T1'),
        finalExcerpt: r1.codexFinal.slice(0, 400),
      })
    }

    // Turn 2: same key -> reuse + delta handoff (or honest full-refresh).
    {
      const signal = turnSignal()
      const started = Date.now()
      const preview = await service.preview({ task: 'Follow-up about the rejected sampling alternative', relevant_files: relevant, mode: 'continue', delegation_key: KEY }, { parent, signal })
      const r2 = await service.delegate({
        task: 'Follow-up, still read-only: two questions. First, name the sampling alternative that the decisions context rejected. Second, summarize what the project context says about the database migration approach. Do not run tools or modify files. Include the exact marker V03_CONT_SMOKE_T2 in your final response.',
        relevant_files: relevant,
        mode: 'continue',
        delegation_key: KEY,
      }, { parent, signal })
      report.turns.push({
        turn: 2, ms: Date.now() - started, previewReused: preview.continuation?.reused ?? null,
        contextChars: r2.contextChars, continuation: r2.continuation,
        markerOk: r2.codexFinal.includes('V03_CONT_SMOKE_T2'),
        finalExcerpt: r2.codexFinal.slice(0, 400),
      })
    }

    // Turn 3: abort mid-flight -> bounded cancellation.
    {
      const controller = new AbortController()
      if (globalController.signal.aborted) controller.abort(globalController.signal.reason)
      else globalController.signal.addEventListener('abort', () => controller.abort(globalController.signal.reason), { once: true })
      const signal = controller.signal
      const started = Date.now()
      const aborter = setTimeout(() => controller.abort(new Error('mid-flight abort')), 2500)
      let cancelCode = null
      try {
        await service.delegate({
          task: 'Still read-only: summarize, in at least two hundred words, how the documented sampling decision weighs simplicity against variance, and list every trade-off the context mentions. Do not run tools or modify files.',
          relevant_files: relevant,
          mode: 'continue',
          delegation_key: KEY,
        }, { parent, signal })
        report.turns.push({ turn: 3, ms: Date.now() - started, cancelled: false })
      } catch (error) {
        cancelCode = error.code ?? null
        report.turns.push({ turn: 3, ms: Date.now() - started, cancelled: true, code: cancelCode })
      } finally {
        clearTimeout(aborter)
      }
      report.cancelCode = cancelCode
    }
  },
}

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
        displayName: 'Gemini via CPA (live continuation smoke)',
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
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 100000 })

  await ctx.plugin(Driver)

  const after = await snapshot()
  report.workspaceUnchanged = JSON.stringify(after) === JSON.stringify(before)
  const persisted = await readdir(persistenceRoot, { recursive: true, withFileTypes: true })
  report.persistenceFiles = persisted.filter(e => e.isFile()).length

  const [t1] = report.turns
  const t2 = report.turns[1]
  const t3 = report.turns[2]
  const distinctChildren = new Set(report.childStarts.map(c => c.id)).size
  report.distinctChildren = distinctChildren
  const checks = {
    turn1FullFreshChild: t1?.continuation?.reused === false && t1?.continuation?.contextMode === 'full',
    turn1Marker: t1?.markerOk === true,
    turn2ReusedSameChild: t2?.continuation?.reused === true && distinctChildren === 1,
    turn2Delta: t2?.continuation?.contextMode === 'delta',
    turn2RevisionAdvanced: t1?.continuation?.revision !== undefined && t2?.continuation?.revision !== undefined
      && t2.continuation.revision !== t1.continuation.revision,
    turn2AckMatchesTarget: t2?.continuation?.revision !== undefined,
    turn2DeltaSmallerThanFull: t2?.continuation?.contextMode === 'delta'
      && t2.continuation.handoffBytes < t1.continuation.handoffBytes,
    turn2Marker: t2?.markerOk === true,
    cancelAcknowledged: t3?.cancelled === true && report.cancelCode === 'CODEX_CANCELLED',
    workspaceUnchanged: report.workspaceUnchanged,
  }
  report.checks = checks
  report.status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL'
  if (report.status === 'FAIL' && t2?.continuation?.contextMode === 'full-refresh') {
    report.note = 'turn 2 fell back to full-refresh (delta not smaller); protocol held but delta evidence is weaker'
  }
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message ?? String(error), stack: error.stack?.split('\n').slice(0, 8) }
} finally {
  clearTimeout(watchdog)
  try { await ctx.fiber.dispose() } catch (error) { report.disposeError = String(error) }
  await rm(persistenceRoot, { recursive: true, force: true })
}
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'PASS') process.exitCode = 1
