import type { DelegationInput, ContextBundle, ContextPreview, ResolvedContextDelegationConfig } from '../types.ts'

/** Content-free selection metadata; no provider or filesystem dependency. */
export function buildContextPreview(input: DelegationInput, context: ContextBundle,
  config: ResolvedContextDelegationConfig): ContextPreview {
  const selection = context.selection
  return {
    task: input.task, mode: config.contextMode, totalChars: context.totalChars,
    maxContextChars: config.maxContextChars,
    mandatory: (selection?.mandatoryFiles ?? context.files).map(file => ({
      relativePath: file.relativePath, chars: file.includedChars, truncated: file.truncated,
    })),
    retrieved: selection?.selectedChunks.map(({ content, ...metadata }) => ({ ...metadata, includedChars: content.length })) ?? [],
    rejectedChunkCount: selection?.rejectedChunks.length ?? 0,
    missingFiles: context.missingFiles,
    sourceLimitedFiles: selection?.sourceLimitedFiles ?? context.truncatedFiles,
    ...(selection ? { budgetUsage: selection.budgetUsage, budgets: selection.budgets, minimumScore: selection.minimumScore } : {}),
  }
}
