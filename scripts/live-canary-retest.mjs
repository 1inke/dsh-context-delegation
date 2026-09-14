// Live retest of reviewed write on the canary fixture with official Codex provider
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { ContextDelegationService, renderCodexExpertResult } from '../lib/index.js'

const harness = resolve(import.meta.dirname, '../../deepseek-harness')
const load = path => import(pathToFileURL(resolve(harness, path)).href)

const { Context } = await load('vendor/cordis/lib/index.js')
const { LocalFileSystem } = await load('packages/fs/fs-local/lib/index.js')
const { default: SubagentRuntime } = await load('packages/subagent/subagent/lib/index.js')
const { default: LocalSubprocessRuntime } = await load('packages/subprocess/subprocess-local/lib/index.js')
const { default: SessionProjectionRegistry } = await load('packages/session/session-projection/lib/index.js')
const codex = await load('packages/subagent/subagent-codex/lib/index.js')

const workspace = process.env.DSH_CANARY_WORKSPACE || 'C:/Users/linke/Desktop/DSH/v1-web-canary-fixture'

const ctx = new Context()
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(new Error('timeout (300s)')), 300000)

let report
try {
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 100000 })
  await ctx.plugin(codex, {
    model: 'gpt-5.6-luna',
    permissionMode: 'approve-for-me',
    env: {},
    disposeGraceMs: 5000,
  })

  const service = new ContextDelegationService(ctx)
  const execution = {
    parent: {
      id: 'canary-retest-parent',
      session: { header: { cwd: workspace } },
    },
    signal: controller.signal,
  }

  const input = {
    mode: 'fresh',
    task: '在当前一次性测试仓库根目录创建 canary-output-2.txt，文件内容必须严格等于 V1_WEB_WRITE_RETEST_OK，不得有换行或其他字符，不修改任何其他文件。',
    acceptance_criteria: [
      'canary-output-2.txt 存在',
      '文件内容严格等于 V1_WEB_WRITE_RETEST_OK',
      '除 canary-output-2.txt 外没有新的文件变化',
    ],
    verification_commands: [
      'node -e "const fs=require(\'node:fs\');process.exit(fs.readFileSync(\'canary-output-2.txt\',\'utf8\')===\'V1_WEB_WRITE_RETEST_OK\'?0:1)"',
    ],
  }

  console.log('Starting reviewed delegation on canary fixture...')
  const result = await service.delegate(input, execution)
  console.log('Delegation completed. Review outcome:', result.review?.outcome)

  const rendered = renderCodexExpertResult(result)
  const fileContent = await readFile(resolve(workspace, 'canary-output-2.txt'), 'utf8')

  report = {
    status: result.review?.outcome === 'completed' && fileContent === 'V1_WEB_WRITE_RETEST_OK' ? 'PASS' : 'FAIL',
    reviewOutcome: result.review?.outcome,
    workspaceEvidenceAvailable: result.review?.workspaceEvidence?.available,
    filesChanged: result.review?.workspaceEvidence?.filesChanged,
    verification: result.review?.verification,
    reviews: result.review?.reviews,
    fileContentExact: fileContent === 'V1_WEB_WRITE_RETEST_OK',
    fileContentLength: fileContent.length,
    renderedSnippet: rendered.slice(0, 500),
  }
} catch (error) {
  report = {
    status: 'FAIL',
    error: error.message,
    code: error.code ?? null,
    stack: error.stack,
  }
} finally {
  clearTimeout(timeout)
  await ctx.fiber.dispose()
}

console.log(JSON.stringify(report, null, 2))
if (report.status !== 'PASS') {
  process.exitCode = 1
}
