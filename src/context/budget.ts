import { ContextDelegationError } from '../errors.ts'
import {
  DEFAULT_TRUNCATION_NOTICE,
  type BudgetedContext,
  type ContextBudgetPolicy,
  type ContextCandidate,
  type LoadedContextFile,
} from '../types.ts'
import { MAX_CONTEXT_CHARS_HARD_LIMIT } from '../config.ts'

/**
 * Normalize line endings in text to standard POSIX newline (\n).
 * Replaces CRLF (\r\n) and legacy CR (\r) with LF (\n).
 */
export function normalizeContextText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Minimum meaningful content characters required when appending a truncation notice. */
const MIN_CONTENT_CHARS_BEFORE_TRUNCATION = 30

/**
 * Budget context candidates deterministically under maxContextChars.
 *
 * Requirements:
 * - Candidates are internally sorted by priority ascending (1 -> 6).
 * - Priority 1 (AGENTS.md) exceeding maxContextChars throws CONTEXT_TOO_LARGE.
 * - Priority 2-6 files are included fully or tail-truncated with DEFAULT_TRUNCATION_NOTICE.
 * - Truncation notice length is strictly counted in the character budget.
 * - UTF-16 surrogate pairs at cut points are protected against split.
 * - Invariant: totalChars <= policy.maxContextChars is strictly enforced.
 */
export function budgetContextFiles(
  candidates: readonly ContextCandidate[],
  policy: ContextBudgetPolicy,
): BudgetedContext {
  const maxChars = policy.maxContextChars
  const notice = policy.truncationNotice ?? DEFAULT_TRUNCATION_NOTICE
  const noticeLength = notice.length

  if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || maxChars > MAX_CONTEXT_CHARS_HARD_LIMIT) {
    throw new ContextDelegationError(
      'PLUGIN_INTERNAL_ERROR',
      `maxContextChars must be a positive safe integer no greater than ${MAX_CONTEXT_CHARS_HARD_LIMIT}.`,
      {
        layer: 'plugin',
        codexInvoked: false,
        workspaceMayHaveChanged: false,
        nextAction: 'Correct the dsh-context-delegation Host configuration and restart DSH.',
      },
    )
  }

  // Normalize here, at the public budgeting boundary, before sorting or counting.
  const sorted = candidates
    .map(candidate => ({
      ...candidate,
      content: normalizeContextText(candidate.content),
      sourceComplete: candidate.sourceComplete ?? true,
    }))
    .sort((a, b) => a.priority - b.priority)

  // Check Priority 1 overflow upfront: AGENTS.md must never be truncated.
  for (const c of sorted) {
    if (c.priority === 1 && (!c.sourceComplete || c.content.length > maxChars)) {
      throw new ContextDelegationError(
        'CONTEXT_TOO_LARGE',
        `AGENTS.md exceeds the maximum context budget (${maxChars}).`,
        {
          layer: 'context',
          codexInvoked: false,
          workspaceMayHaveChanged: false,
          nextAction: 'Reduce the size of AGENTS.md or increase maxContextChars in plugin configuration.',
        },
      )
    }
  }

  let remainingChars = maxChars
  let totalChars = 0
  const loadedFiles: LoadedContextFile[] = []
  const truncatedFiles: string[] = []

  for (const c of sorted) {
    const observedChars = c.content.length
    const originalChars = c.sourceComplete ? observedChars : null

    if (c.sourceComplete && observedChars <= remainingChars) {
      // Fits fully within available budget
      loadedFiles.push({
        id: c.id,
        relativePath: c.relativePath,
        content: c.content,
        originalChars,
        includedChars: observedChars,
        truncated: false,
      })
      remainingChars -= observedChars
      totalChars += observedChars
    } else {
      // Exceeds remaining budget: tail truncation or complete omission
      const minRequired = noticeLength + MIN_CONTENT_CHARS_BEFORE_TRUNCATION

      if (remainingChars >= minRequired) {
        let sliceLen = remainingChars - noticeLength

        // Protect surrogate pair from splitting at boundary
        if (sliceLen > 0 && sliceLen < observedChars) {
          const charCode = c.content.charCodeAt(sliceLen - 1)
          // UTF-16 High Surrogate: 0xD800 to 0xDBFF
          if (charCode >= 0xd800 && charCode <= 0xdbff) {
            sliceLen -= 1
          }
        }

        const truncatedContent = c.content.slice(0, sliceLen) + notice
        const includedChars = truncatedContent.length

        loadedFiles.push({
          id: c.id,
          relativePath: c.relativePath,
          content: truncatedContent,
          originalChars,
          includedChars,
          truncated: true,
        })
        truncatedFiles.push(c.relativePath)
        remainingChars -= includedChars
        totalChars += includedChars
      } else {
        // Insufficient budget for notice + minimum content: omit content entirely
        loadedFiles.push({
          id: c.id,
          relativePath: c.relativePath,
          content: '',
          originalChars,
          includedChars: 0,
          truncated: true,
        })
        truncatedFiles.push(c.relativePath)
      }
    }
  }

  return {
    files: loadedFiles,
    truncatedFiles,
    totalChars,
  }
}
