// Opt-in real-runtime failure injection smoke (V0.9 evidence: cancel during review).
//
// Assembles the official DSH runtime plugins from the harness checkout, creates a
// REAL live parent Agent and a throwaway git workspace, and executes a reviewed
// delegation where the execution signal is aborted while the reviewer child is
// running.
//
// Invariants verified under real LLM execution:
//   - Executor completes and performs work (answer.txt written)
//   - Reviewer is invoked
//   - Cancellation signal interrupts the reviewer
//   - Service rejects cleanly with CODEX_CANCELLED
//   - Error details report workspaceMayHaveChanged: true (honest about partial writes)
//   - No unhandled rejection or process crash occurs
//
// Usage: node scripts/live-failure-smoke.mjs [DSH checkout]
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ContextDelegationService } from '../lib/index.js'

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
const MARKER = 'V09_FAILURE_SMOKE_OK'
const exec = promisify(execFile)

const credPath = process.env.DSH_CREDENTIALS_PATH || join(homedir(), '.dsh/.credentials.yaml')
const credText = await readFile(credPath, 'utf8')
const credMatch = credText.match(/^\s{2}GEMINI_CPA_API_KEY:\s*(.+?)\s*$/m)
if (!credMatch) throw new Error('GEMINI_CPA_API_KEY ref not found in the managed credentials document')
process.env.GEMINI_CPA_API_KEY = credMatch[1].replace(/^["']|["']$/g, '')

const root = await mkdtemp(join(tmpdir(), 'dsh-v09-failure-smoke-'))
await exec('git', ['init', '-b', 'main'], { cwd: root })
await exec('git', ['config', 'user.email', 'smoke@example.test'], { cwd: root })
await exec('git', ['config', 'user.name', 'smoke'], { cwd: root })
await mkdir(join(root, 'harness/context'), { recursive: true })
await writeFile(join(root, 'harness/context/AGENTS.md'), '# Agents\n\nBe safe and honest.\n')
await writeFile(join(root, 'harness/context/CURRENT_STATE.md'), '# Current State\n\nNo answer file yet.\n')
await writeFile(join(root, 'harness/context/CODEX_HANDOFF.md'), '# Handoff Rules\n\nReport honestly with the executor report fence.\n')
await writeFile(join(root, 'widget.ts'), 'export const color = "green"\n')
await exec('git', ['add', '.'], { cwd: root })
await exec('git', ['commit', '-m', 'baseline'], { cwd: root })

const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-v09-failure-smoke-persist-'))
const ctx = new Context()
const subagentStarts = []
ctx.on('subagent/start', info => {
  subagentStarts.push({ id: String(info.id) })
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
        displayName: 'Gemini via CPA (live failure smoke)',
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
  new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 100000 })
  await ctx.plugin(ToolFs)

  let reviewInvoked = false
  let caughtError = null

  const Driver = {
    inject: ['agents', 'subagents', 'sessionProjections', 'sessions', 'llm', 'tools', 'systemPrompt', 'fs'],
    async apply(driverCtx) {
      const service = new ContextDelegationService(driverCtx, {
        providerName: 'spawn',
        reviewProviderName: 'spawn',
        continuationEnabled: false,
        maxReviewRounds: 1,
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

      const rawStart = driverCtx.subagents.start.bind(driverCtx.subagents)
      driverCtx.subagents.start = async (providerName, request) => {
        const run = await rawStart(providerName, request)
        if (request.label === 'Independent review') {
          reviewInvoked = true
          // Abort shortly after reviewer child has been started
          setTimeout(() => {
            globalController.abort()
          }, 100)
        }
        return run
      }

      try {
        await service.delegate({
          task: 'Create a file named answer.txt in the workspace root whose entire content is exactly '
            + MARKER
            + ' (no trailing spaces). Use the filesystem write tool. Then report with the required executor report fence.',
          relevant_files: [],
          acceptance_criteria: [
            'answer.txt exists in the workspace root',
            'answer.txt content is exactly ' + MARKER,
          ],
          verification_commands: [
            `node -e "const fs=require('fs');const t=fs.readFileSync('answer.txt','utf8').trim();process.exit(t==='${MARKER}'?0:1)"`,
          ],
        }, { parent, signal: globalController.signal })
      } catch (err) {
        caughtError = err
      }
    },
  }
  await ctx.plugin(Driver)

  report.reviewInvoked = reviewInvoked
  report.caughtError = caughtError ? {
    code: caughtError.code,
    message: caughtError.message,
    details: caughtError.details,
  } : null

  const answerPath = join(root, 'answer.txt')
  let answerContent = null
  try {
    answerContent = (await readFile(answerPath, 'utf8')).trim()
  } catch {}
  report.answerContent = answerContent

  const checks = {
    reviewWasInvoked: reviewInvoked === true,
    caughtCodexCancelled: caughtError?.code === 'CODEX_CANCELLED',
    workspaceMayHaveChangedTrue: caughtError?.details?.workspaceMayHaveChanged === true,
    executorHadExecuted: answerContent === MARKER,
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
