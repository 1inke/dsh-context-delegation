import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { computeSha256 } from './fingerprint.ts'
import { chunkContext } from './chunker.ts'
import type {
  ContextPatch,
  ContextUpdateProposal,
} from '../types.ts'

/**
 * Reviewed context write-back (roadmap 6). The executor PROPOSES updates;
 * patches are generated only after a reviewer pass, policy-checked, and —
 * in 'apply' mode — applied with parse/size verification before the write
 * and a fingerprint re-computation after it.
 */

const CONTEXT_FILE_NAMES: Record<ContextPatch['target'], string> = {
  CURRENT_STATE: 'CURRENT_STATE.md',
  PROJECT_CONTEXT: 'PROJECT_CONTEXT.md',
  DECISIONS: 'DECISIONS.md',
  EXPERIMENTS: 'EXPERIMENTS.md',
}

/** DECISIONS and EXPERIMENTS are append-only history files. */
const APPEND_ONLY_TARGETS: ReadonlySet<ContextPatch['target']> = new Set(['DECISIONS', 'EXPERIMENTS'])
const APPLY_ONLY_TARGETS: ReadonlySet<ContextPatch['target']> = new Set(Object.keys(CONTEXT_FILE_NAMES) as ContextPatch['target'][])

const MAX_PATCH_CONTENT_CHARS = 4000
const MAX_PATCHES = 8
const MAX_SECTION_HEADING_LEVEL = 6

export interface BuildContextPatchesResult {
  readonly patches: ContextPatch[]
  readonly trustNotes: string[]
}

/**
 * Policy-check an executor proposal into auditable patches. Every dropped
 * element is recorded as a trust note; nothing is guessed into validity.
 */
export function buildContextPatches(proposal: ContextUpdateProposal | undefined): BuildContextPatchesResult {
  const patches: ContextPatch[] = []
  const trustNotes: string[] = []
  if (proposal === undefined) return { patches, trustNotes }

  const overflow = (extra: number) => patches.length + extra > MAX_PATCHES

  const currentState = proposal.currentState ?? []
  if (currentState.length > 0) {
    const content = currentState.map(item => `- ${item}`).join('\n').slice(0, MAX_PATCH_CONTENT_CHARS)
    patches.push({
      target: 'CURRENT_STATE',
      operation: 'append-section',
      headingPath: [],
      content,
      reason: 'current-state update proposed by the executor and accepted by the reviewer',
    })
  }

  const projectContext = proposal.projectContext ?? []
  if (projectContext.length > 0) {
    if (overflow(patches.length + 1)) trustNotes.push('patch limit reached; project-context update dropped')
    else {
      const content = projectContext.map(item => `- ${item}`).join('\n').slice(0, MAX_PATCH_CONTENT_CHARS)
      patches.push({
        target: 'PROJECT_CONTEXT',
        operation: 'append-section',
        headingPath: [],
        content,
        reason: 'project-context update proposed by the executor and accepted by the reviewer',
      })
    }
  }

  for (const decision of proposal.decisions ?? []) {
    if (overflow(1)) { trustNotes.push('patch limit reached; further decisions dropped'); break }
    if (typeof decision.rationale !== 'string' || decision.rationale.trim().length === 0) {
      trustNotes.push(`decision without rationale dropped: ${decision.decision.slice(0, 100)}`)
      continue
    }
    patches.push({
      target: 'DECISIONS',
      operation: 'append-section',
      headingPath: [decision.decision],
      content: decision.rationale.slice(0, MAX_PATCH_CONTENT_CHARS),
      reason: 'reviewer-verified decision adopted during the delegation',
    })
  }

  for (const experiment of proposal.experiments ?? []) {
    if (overflow(1)) { trustNotes.push('patch limit reached; further experiments dropped'); break }
    // Roadmap 6.5: only actually executed experiments may be recorded.
    if (typeof experiment.command !== 'string' || experiment.command.trim().length === 0
      || typeof experiment.result !== 'string' || experiment.result.trim().length === 0) {
      trustNotes.push(`experiment without executed command and result dropped: ${experiment.experiment.slice(0, 100)}`)
      continue
    }
    const content = [
      `Command: ${experiment.command}`,
      `Result: ${experiment.result}`,
      ...(experiment.conclusion === undefined ? [] : [`Conclusion: ${experiment.conclusion}`]),
    ].join('\n').slice(0, MAX_PATCH_CONTENT_CHARS)
    patches.push({
      target: 'EXPERIMENTS',
      operation: 'append-section',
      headingPath: [experiment.experiment],
      content,
      reason: 'experiment actually executed during the delegation and accepted by the reviewer',
    })
  }

  return { patches, trustNotes }
}

/** Stable digest over the four context files' current contents. */
export async function computeContextFingerprint(workspaceRoot: string, contextRoot: string): Promise<string> {
  const parts: string[] = []
  for (const target of Object.keys(CONTEXT_FILE_NAMES) as ContextPatch['target'][]) {
    const path = resolveContextFilePath(workspaceRoot, contextRoot, target)
    let content = ''
    try {
      content = await readFile(path, 'utf8')
    } catch { /* missing file contributes an empty part */ }
    parts.push(`${CONTEXT_FILE_NAMES[target]}\u0000${content}`)
  }
  return computeSha256(parts.join('\u0001'))
}

function resolveContextFilePath(workspaceRoot: string, contextRoot: string, target: ContextPatch['target']): string {
  const root = resolve(workspaceRoot)
  const path = resolve(root, contextRoot, CONTEXT_FILE_NAMES[target])
  // Structural confinement: the target set is fixed and lives inside
  // contextRoot; resolve() + prefix check rejects any traversal attempt.
  if (!path.startsWith(root + '\\') && !path.startsWith(root + '/') && path !== root) {
    throw new Error(`context write-back target escapes the workspace: ${target}`)
  }
  return path
}

interface Section {
  readonly level: number
  readonly title: string
  readonly headingIndex: number
  readonly bodyStart: number
  readonly bodyEnd: number
}

function parseSections(lines: readonly string[]): Section[] {
  const sections: Section[] = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6}) (.+)$/.exec(lines[index] ?? '')
    if (match === null) continue
    const level = match[1]!.length
    const title = match[2]!.trim()
    let bodyEnd = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = /^(#{1,6}) /.exec(lines[cursor] ?? '')
      if (next !== null && next[1]!.length <= level) {
        bodyEnd = cursor
        break
      }
    }
    sections.push({ level, title, headingIndex: index, bodyStart: index + 1, bodyEnd })
  }
  return sections
}

function locateSection(sections: readonly Section[], headingPath: readonly string[]): Section | undefined {
  let candidates = sections
  let match: Section | undefined
  for (const title of headingPath) {
    match = candidates.find(section => section.title === title)
    if (match === undefined) return undefined
    candidates = sections.filter(section => section.headingIndex > match!.headingIndex)
  }
  return match
}

function applyPatchToLines(lines: string[], patch: ContextPatch): string[] {
  const sections = parseSections(lines)
  const section = locateSection(sections, patch.headingPath)
  const contentLines = patch.content.split('\n')

  if (patch.operation === 'replace-section') {
    if (section === undefined) {
      throw new Error(`replace-section target not found: ${patch.headingPath.join(' > ') || '(root)'}`)
    }
    lines.splice(section.bodyStart, section.bodyEnd - section.bodyStart, ...contentLines)
    return lines
  }

  // append-section: into the located section body, or create the heading at EOF.
  if (section === undefined) {
    const created: string[] = []
    for (const title of patch.headingPath) {
      const level = Math.min(MAX_SECTION_HEADING_LEVEL, 2 + patch.headingPath.indexOf(title))
      created.push(`${'#'.repeat(level)} ${title}`)
    }
    return [...lines, '', ...created, '', ...contentLines]
  }
  lines.splice(section.bodyEnd, 0, ...contentLines)
  return lines
}

/** Sanity check shared by proposal-time and post-apply verification. */
function assertParsable(content: string, maxSnapshotBytes: number): void {
  if (Buffer.byteLength(content, 'utf8') > maxSnapshotBytes) {
    throw new Error('patched context file exceeds maxSnapshotBytes')
  }
  const chunks = chunkContext({ sourceId: 'agents', relativePath: '(verification)', content }, { maxChunkChars: 2000 })
  if (chunks.length === 0) throw new Error('patched context file does not parse into chunks')
}

export interface ApplyContextPatchesResult {
  readonly applied: ContextPatch[]
  readonly fingerprintBefore: string
  readonly fingerprintAfter: string
}

/**
 * Apply policy-checked patches to the context files (apply mode only).
 * Each patched full text is parsed and size-checked BEFORE the write; the
 * fingerprint is recomputed after all writes confirm the change.
 */
export async function applyContextPatches(options: {
  workspaceRoot: string
  contextRoot: string
  patches: readonly ContextPatch[]
  maxSnapshotBytes: number
}): Promise<ApplyContextPatchesResult> {
  const fingerprintBefore = await computeContextFingerprint(options.workspaceRoot, options.contextRoot)
  const byFile = new Map<ContextPatch['target'], ContextPatch[]>()
  for (const patch of options.patches) {
    if (!APPLY_ONLY_TARGETS.has(patch.target)) {
      throw new Error(`unknown context write-back target: ${String(patch.target)}`)
    }
    if (APPEND_ONLY_TARGETS.has(patch.target) && patch.operation !== 'append-section') {
      throw new Error(`${patch.target} is append-only; ${patch.operation} rejected`)
    }
    const list = byFile.get(patch.target) ?? []
    list.push(patch)
    byFile.set(patch.target, list)
  }

  for (const [target, patches] of byFile) {
    const path = resolveContextFilePath(options.workspaceRoot, options.contextRoot, target)
    let original = ''
    try {
      original = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const newline = original.includes('\r\n') ? '\r\n' : '\n'
    const lines = original.length === 0 ? [] : original.replace(/\r\n/g, '\n').split('\n')
    // Drop a single trailing empty element from the final newline so appends
    // do not accumulate blank lines, then re-add on write.
    const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === ''
    if (hadTrailingNewline) lines.pop()

    for (const patch of patches) {
      const patchedLines = applyPatchToLines(lines, patch)
      lines.length = 0
      lines.push(...patchedLines)
    }
    let patchedText = lines.join('\n')
    if (hadTrailingNewline || patchedText.length > 0) patchedText += newline
    const normalized = newline === '\r\n' ? patchedText.replaceAll('\n', '\r\n') : patchedText
    assertParsable(normalized, options.maxSnapshotBytes)
    await mkdirFor(path)
    await writeFile(path, normalized, 'utf8')
  }

  const fingerprintAfter = await computeContextFingerprint(options.workspaceRoot, options.contextRoot)
  return { applied: [...options.patches], fingerprintBefore, fingerprintAfter }
}

async function mkdirFor(path: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dirname(path), { recursive: true })
}

export { join as contextWritebackJoin }
