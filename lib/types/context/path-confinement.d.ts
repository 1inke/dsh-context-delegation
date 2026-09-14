import type { ValidateRelevantFilesRequest } from '../types.ts';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
/**
 * Identify whether an error originated from an AbortSignal cancellation or DSH FS_ABORTED.
 */
export declare function isAbortError(err: unknown, signal: AbortSignal): boolean;
/**
 * Normalize and validate a single candidate relative path syntactically.
 * Rejects absolute paths, drive letters, UNC paths, and directory escapes (..) upfront.
 */
export declare function normalizeRelativePath(rawPath: string): string;
/** Resolve and verify the authoritative workspace before any candidate handling. */
export declare function resolveWorkspaceTarget(fs: FileSystem, workspaceRoot: string, signal: AbortSignal): Promise<FsTarget>;
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
export declare function validateRelevantFiles(request: ValidateRelevantFilesRequest): Promise<readonly string[]>;
//# sourceMappingURL=path-confinement.d.ts.map