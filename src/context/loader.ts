import { ContextDelegationError } from '../errors.ts'
import { budgetContextFiles, normalizeContextText } from './budget.ts'
import { isAbortError, resolveWorkspaceTarget } from './path-confinement.ts'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type {
  ContextBundle,
  ContextCandidate,
  ContextFileId,
  LoadPersistentContextRequest,
  ResolvedContextDelegationConfig,
} from '../types.ts'

export { DEFAULT_TRUNCATION_NOTICE } from '../types.ts'

export interface ContextFilePlanEntry {
  readonly id: ContextFileId
  readonly relativePath: string
  readonly priority: number
}

/** Produce the fixed, deterministic V0.1 read plan. No repository scan is performed. */
export function createContextFilePlan(
  config: ResolvedContextDelegationConfig,
): readonly ContextFilePlanEntry[] {
  const underContextRoot = (filename: string): string => `${config.contextRoot}/${filename}`
  return [
    ...(config.includeAgents ? [{ id: 'agents' as const, relativePath: 'AGENTS.md', priority: 1 }] : []),
    ...(config.includeCurrentState
      ? [{ id: 'currentState' as const, relativePath: underContextRoot('CURRENT_STATE.md'), priority: 2 }]
      : []),
    ...(config.includeProjectContext
      ? [{ id: 'projectContext' as const, relativePath: underContextRoot('PROJECT_CONTEXT.md'), priority: 3 }]
      : []),
    ...(config.includeHandoffRules
      ? [{ id: 'handoffRules' as const, relativePath: underContextRoot('CODEX_HANDOFF.md'), priority: 4 }]
      : []),
    ...(config.includeDecisions
      ? [{ id: 'decisions' as const, relativePath: underContextRoot('DECISIONS.md'), priority: 5 }]
      : []),
    ...(config.includeExperiments
      ? [{ id: 'experiments' as const, relativePath: underContextRoot('EXPERIMENTS.md'), priority: 6 }]
      : []),
  ]
}

export type ContextLoader = (request: LoadPersistentContextRequest) => Promise<ContextBundle>

interface BoundedContextRead {
  readonly content: string
  readonly complete: boolean
}

/**
 * Stream and normalize at most maxContextChars + 1 UTF-16 code units.
 * The extra unit proves overflow without buffering the complete source.
 */
async function readBoundedContext(
  fs: FileSystem,
  target: FsTarget,
  maxContextChars: number,
  signal: AbortSignal,
): Promise<BoundedContextRead> {
  const observationLimit = maxContextChars + 1
  const stream = await fs.streamText(target, signal)
  let content = ''
  let pendingCarriageReturn = false

  for await (const chunk of stream) {
    if (signal.aborted) {
      throw new ContextDelegationError(
        'CODEX_CANCELLED',
        'Context loading was cancelled by caller signal.',
        {
          layer: 'delegation',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Retry the delegation request without cancelling the execution signal.',
        },
      )
    }

    let input = pendingCarriageReturn ? `\r${chunk}` : chunk
    pendingCarriageReturn = false
    if (input.endsWith('\r')) {
      input = input.slice(0, -1)
      pendingCarriageReturn = true
    }

    const normalized = normalizeContextText(input)
    const available = observationLimit - content.length
    if (normalized.length >= available) {
      let prefix = normalized.slice(0, available)
      const lastCodeUnit = prefix.charCodeAt(prefix.length - 1)
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1)
      return { content: content + prefix, complete: false }
    }
    content += normalized
  }

  if (pendingCarriageReturn) content += '\n'
  return { content, complete: true }
}

/**
 * Load persistent context files within the workspace according to the resolved plan and budget.
 */
export async function loadContextCandidates(
  request: LoadPersistentContextRequest,
): Promise<{ candidates: ContextCandidate[]; missingFiles: string[] }> {
  const { fs, config, workspaceRoot, signal } = request

  if (signal.aborted) {
    throw new ContextDelegationError(
      'CODEX_CANCELLED',
      'Context loading was cancelled by caller signal.',
      {
        layer: 'delegation',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Retry the delegation request without cancelling the execution signal.',
      },
    )
  }

  const plan = createContextFilePlan(config)

  try {
    const workspaceTarget = await resolveWorkspaceTarget(fs, workspaceRoot, signal)

    const candidates: ContextCandidate[] = []
    const missingFiles: string[] = []

    for (const entry of plan) {
      const candidateTarget = await fs.resolve(entry.relativePath, { cwd: workspaceRoot, signal })
      const isContained = fs.contains(workspaceTarget, candidateTarget)

      if (!isContained) {
        throw new ContextDelegationError(
          'CONTEXT_PATH_ESCAPE',
          `Context file '${entry.relativePath}' resolves outside workspaceRoot (${workspaceRoot}).`,
          {
            layer: 'context',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
          },
        )
      }

      const info = await fs.stat(candidateTarget, signal)
      if (!info) {
        missingFiles.push(entry.relativePath)
        continue
      }

      if (info.type === 'directory') {
        throw new ContextDelegationError(
          'CONTEXT_READ_ERROR',
          `Expected file but found directory at '${entry.relativePath}'.`,
          {
            layer: 'context',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Verify file readability, permissions, and ensure context paths are regular files.',
          },
        )
      }

      if (info.type === 'other') {
        throw new ContextDelegationError(
          'CONTEXT_READ_ERROR',
          `Expected regular file at '${entry.relativePath}' but found '${info.type}'.`,
          {
            layer: 'context',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Verify file readability, permissions, and ensure context paths are regular files.',
          },
        )
      }

      // info.type === 'file'
      const source = await readBoundedContext(fs, candidateTarget, config.maxContextChars, signal)
      candidates.push({
        id: entry.id,
        relativePath: entry.relativePath,
        priority: entry.priority,
        content: source.content,
        sourceComplete: source.complete,
      })
    }

    return { candidates, missingFiles }
  } catch (err) {
    if (err instanceof ContextDelegationError) {
      throw err
    }
    if (isAbortError(err, signal)) {
      throw new ContextDelegationError(
        'CODEX_CANCELLED',
        'Context loading was cancelled by caller signal.',
        {
          layer: 'delegation',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Retry the delegation request without cancelling the execution signal.',
        },
        { cause: err },
      )
    }
    throw new ContextDelegationError(
      'CONTEXT_READ_ERROR',
      `Failed to load persistent context from workspace: ${(err as Error)?.message ?? String(err)}`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Verify file readability, permissions, and ensure context paths are regular files.',
      },
      { cause: err },
    )
  }
}

/** V0.1-compatible public loader, sharing exactly the same secure read path. */
export async function loadPersistentContext(request: LoadPersistentContextRequest): Promise<ContextBundle> {
  const { candidates, missingFiles } = await loadContextCandidates(request)
  const budgeted = budgetContextFiles(candidates, { maxContextChars: request.config.maxContextChars })
  return {
    workspaceRoot: request.workspaceRoot,
    ...budgeted,
    missingFiles,
    ...(budgeted.files.length === 0 ? { warning: 'No persistent context files found in workspace' } : {}),
  }
}
