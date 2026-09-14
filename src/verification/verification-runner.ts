import { spawn } from 'node:child_process'
import { ContextDelegationError } from '../errors.ts'
import type { VerificationEvidence } from '../types.ts'

/**
 * Execute ONLY the caller-authorized verification command strings, in the
 * workspace, with bounded time/output and cancellation. Executor-claimed
 * commands never reach this runner. Denied commands are recorded as
 * `not-run` with a reason — never silently dropped, never executed.
 *
 * Timeouts and cancellation kill the WHOLE process tree: on Windows the
 * platform shell spawns a grandchild, and killing only the shell would leave
 * it running inside the workspace after the runner returned.
 */

/** Case-insensitive substring deny patterns for obviously unsafe commands. */
export const VERIFICATION_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  // Privilege escalation
  /\bsudo\b/i,
  /\brunas\b/i,
  /\bdoas\b/i,
  // Destructive filesystem verbs (anchored to their real command shapes)
  /\bformat(\.com)?\s+[a-z]:/i,
  /\bmkfs/i,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(?:\s|$)/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  // Remote code execution through pipes / dynamic evaluation
  /\|\s*(bash|sh|zsh|pwsh|powershell)\b/i,
  /\binvoke-expression\b/i,
  /\biex\b/i,
  // Network installs
  /\bnpm\s+(install|i)\b/i,
  /\bpnpm\s+(add|install)\b/i,
  /\byarn\s+(add|install)\b/i,
  /\bpip\s+install\b/i,
  /\bgem\s+install\b/i,
  /\bapt(-get)?\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bchoco\s+install\b/i,
  /\bwinget\s+install\b/i,
  // Workspace-escaping VCS mutation
  /\bgit\s+push\b/i,
  /\bgit\s+remote\b/i,
])

const MAX_COMMAND_CHARS = 2000
const MAX_COMMANDS = 10
const EXEC_MAX_BUFFER_BYTES = 1_000_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 16_000

export interface VerificationRunOptions {
  readonly workspaceRoot: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputChars?: number
}

function truncateEvidence(text: string, maxChars: number): string {
  const clean = text.replaceAll('\u0000', '')
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars)}… [truncated]`
}

function deniedEvidence(): string {
  return 'denied: command matches the plugin verification deny list (privilege escalation, destructive, remote-execution, network-install, or workspace-escaping mutation) and was NOT executed'
}

export function isDeniedCommand(command: string): boolean {
  return VERIFICATION_DENY_PATTERNS.some(pattern => pattern.test(command))
}

/** Kill the child and (platform-appropriately) its whole descendant tree. */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    killer.on('error', () => {
      child.kill('SIGKILL')
    })
    return
  }
  try {
    // The child was spawned detached on POSIX, so -pid targets its group.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

interface RunOutcome {
  exitCode: number | null
  timedOut: boolean
  output: string
  startFailure?: string
}

function runOne(
  command: string,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(cancelled())
      return
    }
    const child = spawn(command, {
      shell: true,
      cwd: workspaceRoot,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let timedOut = false
    let outputBytes = 0
    let output = ''
    let settled = false

    const finish = (outcome: RunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(outcome)
    }

    const killForTermination = () => {
      timedOut = true
      killTree(child)
    }

    const timer = setTimeout(killForTermination, timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes <= EXEC_MAX_BUFFER_BYTES) {
        output += chunk.toString('utf8')
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    // exec's maxBuffer semantics: a runaway child is killed, not drained.
    child.stdout?.on('data', () => {
      if (outputBytes > EXEC_MAX_BUFFER_BYTES && !settled) killTree(child)
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (typeof error.code === 'string') {
        finish({ exitCode: null, timedOut: false, output: '', startFailure: `failed to start: ${error.code}` })
        return
      }
      finish({ exitCode: null, timedOut, output })
    })
    child.on('close', (code) => {
      if (signal?.aborted) {
        rejectPromise(cancelled())
        return
      }
      finish({ exitCode: typeof code === 'number' ? code : null, timedOut, output })
    })
  })
}

function cancelled(): ContextDelegationError {
  return new ContextDelegationError(
    'CODEX_CANCELLED',
    'Verification command execution was cancelled.',
    {
      layer: 'delegation',
      codexInvoked: true,
      workspaceMayHaveChanged: true,
      nextAction: 'Inspect the workspace before deciding whether to retry.',
    },
  )
}

/**
 * Run the authorized commands sequentially and return independent evidence.
 * Denied commands yield `outcome: 'not-run'` with a denial reason; commands
 * that cannot start (missing interpreter) also yield `not-run`.
 */
export async function runVerificationCommands(
  commands: readonly string[],
  options: VerificationRunOptions,
): Promise<VerificationEvidence[]> {
  const selected = commands.slice(0, MAX_COMMANDS)
  const results: VerificationEvidence[] = []
  for (const rawCommand of selected) {
    if (options.signal?.aborted) throw cancelled()
    const command = rawCommand.slice(0, MAX_COMMAND_CHARS)
    if (isDeniedCommand(command)) {
      results.push({ command, outcome: 'not-run', timedOut: false, evidence: deniedEvidence() })
      continue
    }
    const outcome = await runOne(
      command,
      options.workspaceRoot,
      options.signal,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (outcome.startFailure !== undefined) {
      results.push({ command, outcome: 'not-run', timedOut: false, evidence: outcome.startFailure })
      continue
    }
    const evidence = truncateEvidence(outcome.output, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)
    results.push({
      command,
      outcome: outcome.exitCode === 0 && !outcome.timedOut ? 'passed' : 'failed',
      ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
      timedOut: outcome.timedOut,
      evidence: evidence.length > 0 ? evidence : '(no output)',
    })
  }
  return results
}
