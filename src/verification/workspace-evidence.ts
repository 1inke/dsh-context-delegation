import { execFile } from 'node:child_process'
import { ContextDelegationError } from '../errors.ts'
import type { WorkspaceEvidence } from '../types.ts'

/**
 * Independent, read-only workspace evidence collected by the PLUGIN (not the
 * executor) via git. Evidence is state-based: it reflects the whole workspace
 * delta at collection time, including any earlier attempt of a rework loop.
 * The plugin never stages, commits, reverts, or otherwise mutates the
 * workspace.
 */

const MAX_CHANGED_FILES = 500
const MAX_DIFF_SUMMARY_CHARS = 500
const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER_BYTES = 1_000_000

export interface WorkspaceEvidenceOptions {
  readonly workspaceRoot: string
  readonly signal?: AbortSignal
}

/** Classify a git execution error into a sanitized, actionable reason. */
export function classifyGitError(error: unknown, fallbackReason = 'git command failed'): string {
  if (error === undefined || error === null) return fallbackReason
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string | number })?.code
  if (code === 'ENOENT' || message.includes('ENOENT')) {
    return 'git binary not found (ENOENT)'
  }
  if (code === 'EPERM' || code === 'EACCES' || message.includes('EPERM') || message.includes('EACCES')) {
    return 'git access denied (EPERM)'
  }
  if (code === 'ETIMEDOUT' || message.includes('timed out') || message.includes('ETIMEDOUT')) {
    return 'git command timed out'
  }
  if (/detected dubious ownership/i.test(message)) {
    return 'git dubious ownership detected'
  }
  if (/not a git repository/i.test(message) || /not a git work tree/i.test(message)) {
    return 'not a git work tree'
  }
  const firstLine = message.split('\n')[0]?.trim() ?? ''
  if (firstLine.length > 0) {
    return `git error: ${firstLine.slice(0, 200)}`
  }
  return fallbackReason
}

function runGit(args: readonly string[], workspaceRoot: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(cancelled())
      return
    }
    execFile(
      'git',
      ['-c', 'safe.directory=*', '-c', 'core.quotepath=false', ...args],
      {
        cwd: workspaceRoot,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        signal,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          rejectPromise(cancelled())
          return
        }
        if (error !== undefined && error !== null) {
          const reason = error instanceof Error ? error.message : String(error)
          rejectPromise(new Error(reason + (stderr ? `: ${stderr.slice(0, 500)}` : '')))
          return
        }
        resolvePromise(stdout)
      },
    )
  })
}

function cancelled(): ContextDelegationError {
  return new ContextDelegationError(
    'CODEX_CANCELLED',
    'Workspace evidence collection was cancelled.',
    {
      layer: 'workspace',
      codexInvoked: true,
      workspaceMayHaveChanged: true,
      nextAction: 'Inspect the workspace before deciding whether to retry.',
    },
  )
}

/** Normalize a git path to forward slashes; porcelain already uses forward slashes. */
function normalizeGitPath(path: string): string {
  return path.replaceAll('\\', '/')
}

function parseChangedFiles(porcelain: string): string[] {
  const files: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const entry = line.slice(3)
    // Rename entries look like `old -> new`; the new path is the live one.
    const arrow = entry.lastIndexOf(' -> ')
    const path = arrow >= 0 ? entry.slice(arrow + 4) : entry
    if (path.length > 0) files.push(normalizeGitPath(path))
    if (files.length >= MAX_CHANGED_FILES) break
  }
  return files
}

function extractDiffSummary(diffStat: string): string | undefined {
  const lines = diffStat.trimEnd().split('\n')
  const summary = lines[lines.length - 1]?.trim() ?? ''
  if (summary.length === 0 || !/changed/i.test(summary)) return undefined
  return summary.slice(0, MAX_DIFF_SUMMARY_CHARS)
}

/**
 * Collect independent workspace evidence for one reviewed attempt. For a
 * non-git workspace this returns `available: false` with a reason — evidence
 * gaps are reported, never fabricated.
 */
export async function collectWorkspaceEvidence(options: WorkspaceEvidenceOptions): Promise<WorkspaceEvidence> {
  const { workspaceRoot, signal } = options
  let inside: string
  try {
    inside = (await runGit(['rev-parse', '--is-inside-work-tree'], workspaceRoot, signal)).trim()
  } catch (error) {
    if (error instanceof ContextDelegationError) throw error
    return { available: false, reason: classifyGitError(error, 'not a git work tree'), filesChanged: [] }
  }
  if (inside !== 'true') {
    return { available: false, reason: 'not a git work tree', filesChanged: [] }
  }

  let status = ''
  let diffStat = ''
  try {
    status = await runGit(['status', '--porcelain=v1', '-uall'], workspaceRoot, signal)
  } catch (error) {
    if (error instanceof ContextDelegationError) throw error
    return { available: false, reason: classifyGitError(error, 'git status failed'), filesChanged: [] }
  }
  try {
    // `HEAD` fails on a repository without commits; evidence stays available
    // (untracked files are still visible) but without a diff summary.
    diffStat = await runGit(['diff', '--stat', 'HEAD'], workspaceRoot, signal)
  } catch (error) {
    if (error instanceof ContextDelegationError) throw error
    diffStat = ''
  }

  const diffSummary = extractDiffSummary(diffStat)
  return {
    available: true,
    filesChanged: parseChangedFiles(status),
    ...(diffSummary === undefined ? {} : { diffSummary }),
  }
}
