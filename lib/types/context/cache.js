import { computeSha256 } from "./fingerprint.js";
/**
 * Process-local LRU cache for deterministic Markdown chunking (roadmap
 * V0.8). Keyed by protocol version, source identity, chunker options, and
 * the sha256 of the normalized content — the hash is a strictly stronger
 * identity than mtime/size, so a stale hit is impossible by construction.
 * Consumers only ever read the chunk arrays; the cache hands out the same
 * frozen instance on every hit.
 */
export const CHUNK_CACHE_PROTOCOL_VERSION = 'v1';
export const CHUNK_CACHE_MAX_ENTRIES = 64;
const store = new Map();
const stats = { hits: 0, misses: 0, evictions: 0 };
export function chunkCacheStats() {
    return { ...stats, size: store.size };
}
export function clearChunkCache() {
    store.clear();
    stats.hits = 0;
    stats.misses = 0;
    stats.evictions = 0;
}
function buildKey(sourceId, relativePath, contentHash, maxChunkChars) {
    return [CHUNK_CACHE_PROTOCOL_VERSION, sourceId, relativePath, String(maxChunkChars), contentHash].join('|');
}
/**
 * Return the cached chunks for the key, or compute them through `compute`
 * and store the result. LRU order is refreshed on hits.
 */
export function getCachedChunks(sourceId, relativePath, content, maxChunkChars, compute) {
    const contentHash = computeSha256(content);
    const key = buildKey(sourceId, relativePath, contentHash, maxChunkChars);
    const hit = store.get(key);
    if (hit !== undefined) {
        stats.hits += 1;
        // Map iteration order is LRU order: refresh by re-inserting.
        store.delete(key);
        store.set(key, hit);
        return hit;
    }
    stats.misses += 1;
    const computed = Object.freeze(compute({ sourceId, relativePath, content }).map(chunk => Object.freeze({ ...chunk })));
    store.set(key, computed);
    while (store.size > CHUNK_CACHE_MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest === undefined)
            break;
        store.delete(oldest);
        stats.evictions += 1;
    }
    return computed;
}
//# sourceMappingURL=cache.js.map