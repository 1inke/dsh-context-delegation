import type { ContextFileId, ContextChunk } from '../types.ts';
type Input = {
    sourceId: ContextFileId;
    relativePath: string;
    content: string;
};
type Options = {
    maxChunkChars?: number;
    minChunkChars?: number;
};
export declare function chunkContext(source: Input, options?: Options): ContextChunk[];
export {};
//# sourceMappingURL=chunker.d.ts.map