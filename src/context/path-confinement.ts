import { ContextDelegationError } from '../errors.ts'
import type { ValidateRelevantFilesRequest } from '../types.ts'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/**
 * Identify whether an error originated from an AbortSignal cancellation or DSH FS_ABORTED.
 */
export function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (err && typeof err === 'object') {
    if ('name' in err && (err as { name?: string }).name === 'AbortError') return true
    if ('code' in err && (err as { code?: string }).code === 'FS_ABORTED') return true
  }
  return false
}

/**
 * Normalize and validate a single candidate relative path syntactically.
 * Rejects absolute paths, drive letters, UNC paths, and directory escapes (..) upfront.
 */
export function normalizeRelativePath(rawPath: string): string {
  if (!rawPath.trim()) {
    throw new ContextDelegationError(
      'CONTEXT_PATH_ESCAPE',
      'Empty path in relevant_files.',
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
      },
    )
  }

  if (rawPath.trim() !== rawPath) {
    throw new ContextDelegationError(
      'CONTEXT_PATH_ESCAPE',
      `Path '${rawPath}' in relevant_files must not contain surrounding whitespace.`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
      },
    )
  }

  const candidatePath = rawPath

  // Reject leading slashes or backslashes
  if (candidatePath.startsWith('/') || candidatePath.startsWith('\\')) {
    throw new ContextDelegationError(
      'CONTEXT_PATH_ESCAPE',
      `Path '${rawPath}' in relevant_files must be a relative path, not absolute.`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
      },
    )
  }

  // Reject Windows drive letters (e.g. C:, D:) or UNC network prefixes (\\)
  if (/^[a-zA-Z]:/.test(candidatePath) || candidatePath.startsWith('\\\\')) {
    throw new ContextDelegationError(
      'CONTEXT_PATH_ESCAPE',
      `Path '${rawPath}' in relevant_files contains a drive letter or UNC prefix.`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
      },
    )
  }

  // Normalize slashes to POSIX /
  const posix = candidatePath.replace(/\\/g, '/')

  // Lexically resolve path segments to detect directory traversal escape
  const stack: string[] = []
  for (const seg of posix.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) {
        throw new ContextDelegationError(
          'CONTEXT_PATH_ESCAPE',
          `Path '${rawPath}' traverses outside workspace root via parent segment (..).`,
          {
            layer: 'context',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
          },
        )
      }
      stack.pop()
    } else {
      stack.push(seg)
    }
  }

  if (stack.length === 0) {
    throw new ContextDelegationError(
      'CONTEXT_PATH_ESCAPE',
      `Path '${rawPath}' resolves to workspace root itself, not a valid target file.`,
      {
        layer: 'context',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
      },
    )
  }

  return stack.join('/')
}

function cancelledError(options?: ErrorOptions): ContextDelegationError {
  return new ContextDelegationError(
    'CODEX_CANCELLED',
    'Context loading was cancelled by caller signal.',
    {
      layer: 'delegation',
      codexInvoked: false,
      workspaceMayHaveChanged: false,
      nextAction: 'Retry the delegation request without cancelling the execution signal.',
    },
    options,
  )
}

function workspaceError(workspaceRoot: string, reason: string, options?: ErrorOptions): ContextDelegationError {
  return new ContextDelegationError(
    'WORKSPACE_NOT_FOUND',
    `Authoritative workspace '${workspaceRoot}' is not a usable directory: ${reason}`,
    {
      layer: 'workspace',
      codexInvoked: false,
      workspaceMayHaveChanged: false,
      nextAction: 'Ensure the calling agent has an active session with a valid cwd.',
    },
    options,
  )
}

/** Resolve and verify the authoritative workspace before any candidate handling. */
export async function resolveWorkspaceTarget(
  fs: FileSystem,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<FsTarget> {
  try {
    const target = await fs.resolve('.', { cwd: workspaceRoot, signal })
    const info = await fs.stat(target, signal)
    if (!info) throw workspaceError(workspaceRoot, 'the path does not exist')
    if (info.type !== 'directory') throw workspaceError(workspaceRoot, `expected a directory but found '${info.type}'`)
    return target
  } catch (err) {
    if (err instanceof ContextDelegationError) throw err
    if (isAbortError(err, signal)) throw cancelledError({ cause: err })
    throw workspaceError(workspaceRoot, (err as Error)?.message ?? String(err), { cause: err })
  }
}

/**
 * Validate model-supplied relevant_files against workspace boundary and safety rules.
 *
 * Rules:
 * - Requires mandatory AbortSignal; abort maps to CODEX_CANCELLED.
 * - Rejects absolute paths, UNC paths, and parent traversal with CONTEXT_PATH_ESCAPE.
 * - Resolves canonical FsTarget and verifies fs.contains(workspaceTarget, candidateTarget).
 * - Rejects directories and non-regular special files with CONTEXT_READ_ERROR.
 * - Allows non-existent files if their resolved target is contained within the workspace.
 * - Deduplicates while strictly preserving order of first appearance.
 * - Never calls any content-read operation on relevant_files targets.
 */
export async function validateRelevantFiles(
  request: ValidateRelevantFilesRequest,
): Promise<readonly string[]> {
  const { fs, workspaceRoot, relevantFiles, signal } = request

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

  try {
    const workspaceTarget = await resolveWorkspaceTarget(fs, workspaceRoot, signal)

    if (!relevantFiles || relevantFiles.length === 0) {
      return Object.freeze([])
    }

    const uniquePaths: string[] = []
    const seenLexical = new Set<string>()
    const seenTargets = new Set<string>()
    const caseInsensitive = /^[a-zA-Z]:[\\/]/.test(workspaceRoot) || workspaceRoot.startsWith('\\\\')

    for (const raw of relevantFiles) {
      const normalized = normalizeRelativePath(raw)
      const lexicalKey = caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized
      if (seenLexical.has(lexicalKey)) {
        continue
      }
      seenLexical.add(lexicalKey)

      const candidateTarget = await fs.resolve(normalized, { cwd: workspaceRoot, signal })
      const isContained = fs.contains(workspaceTarget, candidateTarget)

      if (!isContained) {
        throw new ContextDelegationError(
          'CONTEXT_PATH_ESCAPE',
          `Path '${normalized}' resolves outside workspaceRoot (${workspaceRoot}).`,
          {
            layer: 'context',
            codexInvoked: false,
            workspaceMayHaveChanged: false,
            nextAction: 'Ensure all context and relevant files reside strictly within the workspace root.',
          },
        )
      }

      const targetKey = String(candidateTarget.targetKey)
      if (seenTargets.has(targetKey)) continue
      seenTargets.add(targetKey)

      // Check target metadata if exists
      const info = await fs.stat(candidateTarget, signal)
      if (info !== undefined) {
        if (info.type === 'directory') {
          throw new ContextDelegationError(
            'CONTEXT_READ_ERROR',
            `relevant_files path '${normalized}' is a directory, not a file.`,
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
            `relevant_files path '${normalized}' is a special non-regular file (${info.type}).`,
            {
              layer: 'context',
              codexInvoked: false,
              workspaceMayHaveChanged: false,
              nextAction: 'Verify file readability, permissions, and ensure context paths are regular files.',
            },
          )
        }
        // info.type === 'file': Valid existing file
      }
      // If info is undefined: target doesn't exist yet, but lexical & containment checks passed -> valid!

      uniquePaths.push(normalized)
    }

    return Object.freeze(uniquePaths)
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
      `Failed to validate relevant_files in workspace: ${(err as Error)?.message ?? String(err)}`,
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
