import type { ContextChunk, ContextQuery, ScoredContextChunk } from '../types.ts'
import { tokenizeContext } from './query.ts'

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function includesPath(path: string, text: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').toLocaleLowerCase('en-US')
  const normalizedText = text.replaceAll('\\', '/').toLocaleLowerCase('en-US')
  if (!normalizedPath) return false
  const pathChar = /[\p{L}\p{N}_./-]/u
  let offset = normalizedText.indexOf(normalizedPath)
  while (offset >= 0) {
    const before = offset === 0 ? '' : normalizedText[offset - 1]!
    const after = normalizedText[offset + normalizedPath.length] ?? ''
    if (!pathChar.test(before) && !pathChar.test(after)) return true
    offset = normalizedText.indexOf(normalizedPath, offset + 1)
  }
  return false
}

export function rankContextChunks(
  chunks: readonly ContextChunk[],
  query: ContextQuery,
): ScoredContextChunk[] {
  const queryTerms = new Set(query.terms)
  // Shared storage directories do not distinguish candidate sources. Otherwise
  // a routine word such as "context" gives every stored chunk a path bonus.
  const directories = chunks.map(chunk => {
    const path = chunk.relativePath.replaceAll('\\', '/')
    return new Set(tokenizeContext(path.slice(0, Math.max(0, path.lastIndexOf('/')))))
  })
  const commonDirectoryTerms = new Set(directories[0] ?? [])
  for (const directory of directories) {
    for (const term of commonDirectoryTerms) if (!directory.has(term)) commonDirectoryTerms.delete(term)
  }
  const results = chunks.map((chunk) => {
    const heading = chunk.headingPath.join(' ')
    const headingTokens = new Set(tokenizeContext(heading))
    const bodyTokens = new Set(tokenizeContext(chunk.content))
    const pathTokens = new Set(tokenizeContext(chunk.relativePath)
      .filter(term => !commonDirectoryTerms.has(term) && term !== 'md' && term !== 'markdown'))
    const matched = new Set<string>()
    let score = 0
    for (const term of queryTerms) {
      const headingExact = chunk.headingPath.some((part) => part.toLocaleLowerCase('en-US') === term)
      const headingHit = headingTokens.has(term)
      const bodyHit = bodyTokens.has(term)
      const pathHit = pathTokens.has(term)
      if (headingExact) { score += 5; matched.add(term) }
      if (headingHit) { score += 3; matched.add(term) }
      if (bodyHit) { score += 1; matched.add(term) }
      if (pathHit) { score += 4; matched.add(term) }
    }
    for (const file of query.relevantFiles) {
      if (includesPath(file, chunk.content) || includesPath(file, heading)) {
        score += 5
        matched.add(file)
      }
    }
    return { ...chunk, score, matchedTerms: [...matched] }
  })
  return results.sort((a, b) =>
    b.score - a.score || compareText(a.relativePath, b.relativePath) ||
    (a.startLine ?? 0) - (b.startLine ?? 0) ||
    compareText(a.headingPath.join('\u0000'), b.headingPath.join('\u0000')) ||
    compareText(a.content, b.content),
  )
}
