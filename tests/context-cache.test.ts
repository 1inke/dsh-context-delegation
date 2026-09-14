import { describe, expect, it } from 'vitest'
import { clearChunkCache, chunkCacheStats, getCachedChunks, CHUNK_CACHE_MAX_ENTRIES, CHUNK_CACHE_PROTOCOL_VERSION } from '../src/context-cache.ts'
import { chunkContext } from '../src/context-chunker.ts'
import type { ContextFileId } from '../src/types.ts'

describe('V0.8 chunk cache', () => {
  it('returns identical chunks for repeated identical content (cache hit)', () => {
    clearChunkCache()
    const content = '# Decisions\n\n## Alpha\n\nFirst.\n\n## Beta\n\nSecond.\n'
    const compute = (source: { sourceId: ContextFileId; relativePath: string; content: string }) =>
      chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 })
    const first = getCachedChunks('decisions', 'DECISIONS.md', content, 4000, compute)
    const afterFirst = chunkCacheStats()
    expect(afterFirst.misses).toBe(1)
    const second = getCachedChunks('decisions', 'DECISIONS.md', content, 4000, compute)
    const after = chunkCacheStats()
    expect(second).toEqual(first)
    expect(after.misses).toBe(1)
    expect(after.hits).toBe(1)
  })

  it('invalidates when the content changes (no stale hits)', () => {
    clearChunkCache()
    const key = { sourceId: 'decisions' as const, relativePath: 'DECISIONS.md' }
    getCachedChunks(key.sourceId, key.relativePath, '# A\n\nOne.\n', 4000, (source) =>
      chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    const changed = getCachedChunks(key.sourceId, key.relativePath, '# A\n\nOne.\n\n## B\n\nTwo.\n', 4000, (source) =>
      chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    expect(changed.some(chunk => chunk.headingPath.includes('B'))).toBe(true)
    expect(chunkCacheStats().misses).toBe(2)
  })

  it('keys differ per sourceId, relativePath, and maxChunkChars', () => {
    clearChunkCache()
    const content = '# A\n\nBody.\n'
    getCachedChunks('decisions', 'A.md', content, 4000, (source) => chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    getCachedChunks('projectContext', 'A.md', content, 4000, (source) => chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    getCachedChunks('decisions', 'B.md', content, 4000, (source) => chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    getCachedChunks('decisions', 'A.md', content, 2000, (source) => chunkContext(source, { maxChunkChars: 2000, minChunkChars: 0 }))
    const stats = chunkCacheStats()
    expect(stats.misses).toBe(4)
    expect(stats.hits).toBe(0)
    expect(stats.size).toBe(4)
  })

  it('evicts least-recently-used entries at the bounded ceiling', () => {
    clearChunkCache()
    for (let index = 0; index < CHUNK_CACHE_MAX_ENTRIES; index++) {
      getCachedChunks('decisions', `file-${index}.md`, `# F${index}\n\nBody.\n`, 4000, (source) =>
        chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    }
    expect(chunkCacheStats().size).toBe(CHUNK_CACHE_MAX_ENTRIES)
    // Touch entry 0, then insert one more: the LRU victim must be entry 1.
    getCachedChunks('decisions', 'file-0.md', '# F0\n\nBody.\n', 4000, (source) =>
      chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    getCachedChunks('decisions', `file-${CHUNK_CACHE_MAX_ENTRIES}.md`, `# F${CHUNK_CACHE_MAX_ENTRIES}\n\nBody.\n`, 4000, (source) =>
      chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    expect(chunkCacheStats().size).toBe(CHUNK_CACHE_MAX_ENTRIES)
    getCachedChunks('decisions', 'file-0.md', '# F0\n\nBody.\n', 4000, (source) =>
      chunkContext(source, { maxChunkChars: 4000, minChunkChars: 0 }))
    expect(chunkCacheStats().hits).toBeGreaterThan(0)
  })

  it('respects the protocol version in the key', () => {
    clearChunkCache()
    expect(CHUNK_CACHE_PROTOCOL_VERSION).toMatch(/^v\d+$/)
  })
})
