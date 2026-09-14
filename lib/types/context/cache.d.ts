import type { ContextChunk, ContextFileId } from '../types.ts';
/**
 * Process-local LRU cache for deterministic Markdown chunking (roadmap
 * V0.8). Keyed by protocol version, source identity, chunker options, and
 * the sha256 of the normalized content — the hash is a strictly stronger
 * identity than mtime/size, so a stale hit is impossible by construction.
 * Consumers only ever read the chunk arrays; the cache hands out the same
 * frozen instance on every hit.
 */
export declare const CHUNK_CACHE_PROTOCOL_VERSION = "v1";
export declare const CHUNK_CACHE_MAX_ENTRIES = 64;
export interface ChunkCacheStats {
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly evictions: number;
}
export declare function chunkCacheStats(): ChunkCacheStats;
export declare function clearChunkCache(): void;
/**
 * Return the cached chunks for the key, or compute them through `compute`
 * and store the result. LRU order is refreshed on hits.
 */
export declare function getCachedChunks(sourceId: ContextFileId, relativePath: string, content: string, maxChunkChars: number, compute: (source: {
    sourceId: ContextFileId;
    relativePath: string;
    content: string;
}) => readonly ContextChunk[]): readonly ContextChunk[];
//# sourceMappingURL=cache.d.ts.map