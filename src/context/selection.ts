import { getCachedChunks } from './cache.ts'
import { normalizeContextText } from './budget.ts'
import { chunkContext } from './chunker.ts'
import { buildContextQuery } from './query.ts'
import { rankContextChunks } from './retrieval.ts'
import { resolveConfig } from '../config.ts'
import { ContextDelegationError } from '../errors.ts'
import type { DelegationInput, ContextCandidate, ContextSelection, LoadedContextFile, ResolvedContextDelegationConfig, ScoredContextChunk } from '../types.ts'

const mandatoryIds = ['agents', 'currentState', 'handoffRules'] as const
const categories = { projectContext: 'project', decisions: 'decisions', experiments: 'experiments' } as const

/** Deterministic selection; rejects mandatory overflow and never borrows its reserve. */
export function selectContext(sources: readonly ContextCandidate[], input: DelegationInput,
  relevantFiles: readonly string[], rawConfig: ResolvedContextDelegationConfig): ContextSelection {
  const config = resolveConfig(rawConfig)
  const budgets = config.contextBudgets
  const budgetUsage = { mandatory: 0, project: 0, decisions: 0, experiments: 0 }
  const mandatoryFiles: LoadedContextFile[] = []
  const normalized = sources.map(source => ({ ...source, content: normalizeContextText(source.content) }))
  for (const id of mandatoryIds) {
    for (const source of normalized.filter(source => source.id === id)) {
      budgetUsage.mandatory += source.content.length
      if (source.sourceComplete === false || budgetUsage.mandatory > budgets.mandatory) {
        throw new ContextDelegationError('CONTEXT_TOO_LARGE', 'Mandatory context exceeds its reserved budget.', {
          layer: 'context', codexInvoked: false, workspaceMayHaveChanged: false,
          nextAction: 'Reduce mandatory context or increase the operator-owned mandatory and total budgets.',
        })
      }
      mandatoryFiles.push({ id, relativePath: source.relativePath, content: source.content,
        originalChars: source.content.length, includedChars: source.content.length, truncated: false })
    }
  }
  const chunks = normalized.filter(source => source.id in categories).flatMap(source => {
    const category = categories[source.id as keyof typeof categories]
    if (budgets[category] === 0) return []
    const maxChunkChars = Math.max(2, Math.min(4000, budgets[category]))
    try {
      return config.cacheEnabled
        ? getCachedChunks(source.id, source.relativePath, source.content, maxChunkChars, chunkSource =>
          chunkContext(chunkSource, { maxChunkChars, minChunkChars: 0 }))
        : chunkContext({ sourceId: source.id, relativePath: source.relativePath, content: source.content },
          { maxChunkChars, minChunkChars: 0 })
    } catch (cause) {
      if (!(cause instanceof RangeError)) throw cause
      throw new ContextDelegationError('CONTEXT_TOO_LARGE', 'Context exceeds the per-source chunk limit.', {
        layer: 'context', codexInvoked: false, workspaceMayHaveChanged: false,
        nextAction: 'Consolidate tiny context sections or increase a very small category budget.',
      }, { cause })
    }
  })
  const ranked = rankContextChunks(chunks, buildContextQuery(input, relevantFiles))
  // Keep incidental boilerplate matches from filling every category. The
  // operator may set the ratio to zero to retain every positive-score chunk.
  const minimumScore = Math.max(1, (ranked[0]?.score ?? 0) * config.contextMinRelativeScore)
  const selectedChunks: ScoredContextChunk[] = []
  const rejectedChunks: ScoredContextChunk[] = []
  const seen = new Set<string>()
  for (const chunk of ranked) {
    const category = categories[chunk.sourceId as keyof typeof categories]
    const key = JSON.stringify([chunk.relativePath, chunk.headingPath, chunk.content])
    if (chunk.score < minimumScore || seen.has(key) || budgetUsage[category] + chunk.content.length > budgets[category]) {
      rejectedChunks.push(chunk)
      continue
    }
    seen.add(key)
    selectedChunks.push(chunk)
    budgetUsage[category] += chunk.content.length
  }
  return { mandatoryFiles, selectedChunks, rejectedChunks, budgetUsage, budgets, minimumScore,
    totalChars: Object.values(budgetUsage).reduce((a, b) => a + b, 0),
    sourceLimitedFiles: sources.filter(source => source.sourceComplete === false).map(source => source.relativePath) }
}
