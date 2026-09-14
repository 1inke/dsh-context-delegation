import { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

export type TestEntry =
  | { type: 'file'; content: string; version?: string }
  | { type: 'directory'; version?: string }
  | { type: 'symlink'; target: string; version?: string }
  | { type: 'other'; version?: string }

export type RecordedFsCall =
  | { method: 'resolve'; path: string; cwd?: string | undefined; signal?: AbortSignal | undefined }
  | { method: 'stat'; targetKey: string; signal?: AbortSignal | undefined }
  | { method: 'lstat'; path: string; cwd?: string | undefined; signal?: AbortSignal | undefined }
  | { method: 'readText'; targetKey: string; signal?: AbortSignal | undefined }
  | { method: 'streamText'; targetKey: string; signal?: AbortSignal | undefined }
  | { method: 'streamChunk'; targetKey: string; index: number; length: number }
  | { method: 'contains'; parentKey: string; childKey: string }
  | { method: 'listDir'; targetKey: string; signal?: AbortSignal | undefined }

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/')
  normalized = normalized.replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

function resolvePath(base: string, rel: string): string {
  if (!rel || rel === '.') return base
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return normalizePath(rel)
  const hasDriveRoot = /^[a-zA-Z]:\//.test(base)
  const parts = (base === '/' ? '' : base).split('/').filter(Boolean)
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return (hasDriveRoot ? '' : '/') + parts.join('/')
}

export class RecordingFileSystem extends FileSystem {
  readonly entries = new Map<string, TestEntry>()
  readonly calls: RecordedFsCall[] = []
  readonly aliases = new Map<string, string>()
  readonly failures = new Map<string, Error>()
  readonly streamChunks = new Map<string, readonly string[]>()

  constructor(ctx: Context = new Context()) {
    super(ctx)
  }

  setFile(path: string, content: string): this {
    this.entries.set(normalizePath(path), { type: 'file', content })
    return this
  }

  setStreamChunks(path: string, chunks: readonly string[]): this {
    const normalized = normalizePath(path)
    this.entries.set(normalized, { type: 'file', content: chunks.join('') })
    this.streamChunks.set(normalized, [...chunks])
    return this
  }

  setDirectory(path: string): this {
    this.entries.set(normalizePath(path), { type: 'directory' })
    return this
  }

  setSymlink(path: string, target: string): this {
    this.entries.set(normalizePath(path), { type: 'symlink', target: normalizePath(target) })
    return this
  }

  setOther(path: string): this {
    this.entries.set(normalizePath(path), { type: 'other' })
    return this
  }

  setFailure(key: string, error: Error): this {
    this.failures.set(key, error)
    return this
  }

  private checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new FsError('The filesystem operation was aborted', 'FS_ABORTED')
    }
  }

  private canonicalize(normPath: string, depth = 0): string {
    if (depth > 10) {
      throw new FsError('Too many symbolic links', 'FS_IO_ERROR')
    }
    const aliased = this.aliases.get(normPath)
    if (aliased) {
      return this.canonicalize(aliased, depth + 1)
    }
    const entry = this.entries.get(normPath)
    if (entry && entry.type === 'symlink') {
      return this.canonicalize(entry.target, depth + 1)
    }
    return normPath
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    this.calls.push({ method: 'resolve', path, cwd: opts?.cwd, signal: opts?.signal })
    this.checkSignal(opts?.signal)
    const failure = this.failures.get(`resolve:${path}`) ?? this.failures.get(path)
    if (failure) throw failure

    const base = opts?.cwd ? normalizePath(opts.cwd) : '/'
    const absPath = resolvePath(base, path)
    const canonical = this.canonicalize(absPath)
    return {
      targetKey: FsTargetKey(canonical),
      displayPath: canonical,
    }
  }

  processPath(target: FsTarget): string {
    return target.displayPath
  }

  fileUrl(target: FsTarget): string {
    return `file://${target.displayPath}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const parentKey = parent.targetKey as string
    const childKey = child.targetKey as string
    this.calls.push({ method: 'contains', parentKey, childKey })

    if (parentKey === childKey) return true
    const prefix = parentKey.endsWith('/') ? parentKey : `${parentKey}/`
    return childKey.startsWith(prefix)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const key = target.targetKey as string
    this.calls.push({ method: 'stat', targetKey: key, signal })
    this.checkSignal(signal)
    const failure = this.failures.get(`stat:${key}`) ?? this.failures.get(key)
    if (failure) throw failure

    const entry = this.entries.get(key)
    if (!entry) return undefined

    const type = entry.type === 'symlink' ? 'file' : entry.type
    return {
      version: FsVersion(entry.version ?? '1'),
      type,
      ...(type === 'file' && entry.type === 'file' ? { size: entry.content.length } : {}),
    }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    this.calls.push({ method: 'lstat', path, cwd: opts?.cwd, signal })
    this.checkSignal(signal)
    const failure = this.failures.get(`lstat:${path}`) ?? this.failures.get(path)
    if (failure) throw failure

    const base = opts?.cwd ? normalizePath(opts.cwd) : '/'
    const absPath = resolvePath(base, path)
    const entry = this.entries.get(absPath)
    if (!entry) return undefined

    return {
      version: FsVersion(entry.version ?? '1'),
      type: entry.type,
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const key = target.targetKey as string
    this.calls.push({ method: 'readText', targetKey: key, signal })
    this.checkSignal(signal)
    const failure = this.failures.get(`readText:${key}`) ?? this.failures.get(key)
    if (failure) throw failure

    const entry = this.entries.get(key)
    if (!entry) {
      throw new FsError(`File not found: ${key}`, 'FS_IO_ERROR')
    }
    if (entry.type !== 'file') {
      throw new FsError(`Target is not a file (${entry.type}): ${key}`, 'FS_IO_ERROR')
    }
    return entry.content
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const key = target.targetKey as string
    this.calls.push({ method: 'streamText', targetKey: key, signal })
    this.checkSignal(signal)
    const failure = this.failures.get(`streamText:${key}`) ?? this.failures.get(key)
    if (failure) throw failure

    const entry = this.entries.get(key)
    if (!entry) throw new FsError(`File not found: ${key}`, 'FS_IO_ERROR')
    if (entry.type !== 'file') throw new FsError(`Target is not a file (${entry.type}): ${key}`, 'FS_IO_ERROR')
    const chunks = this.streamChunks.get(key) ?? [entry.content]
    const owner = this
    return {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < chunks.length; index += 1) {
          owner.checkSignal(signal)
          const chunk = chunks[index]!
          owner.calls.push({ method: 'streamChunk', targetKey: key, index, length: chunk.length })
          yield chunk
        }
      },
    }
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const text = await this.readText(target, signal)
    const bytes = new TextEncoder().encode(text)
    if (bytes.length > maxBytes) {
      throw new FsError('File exceeds maxBytes', 'FS_IO_ERROR')
    }
    return bytes
  }

  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const text = await this.readText(target, signal)
    const bytes = new TextEncoder().encode(text)
    return bytes.slice(range.offset, range.offset + range.length)
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const key = target.targetKey as string
    this.calls.push({ method: 'listDir', targetKey: key, signal })
    this.checkSignal(signal)
    const results: FsDirEntry[] = []
    const prefix = key.endsWith('/') ? key : `${key}/`
    for (const [entryPath, entry] of this.entries) {
      if (entryPath.startsWith(prefix)) {
        const rest = entryPath.slice(prefix.length)
        if (!rest.includes('/')) {
          results.push({
            name: rest,
            type: entry.type === 'symlink' ? 'file' : entry.type,
            target: { targetKey: FsTargetKey(entryPath), displayPath: entryPath },
          })
        }
      }
    }
    return results
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<FsWriteOutcome> {
    void target
    void content
    void expected
    void signal
    void sandboxPolicy
    throw new Error('RecordingFileSystem is read-only for testing; writeText is forbidden.')
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<FsEditOutcome> {
    void target
    void edit
    void expected
    void signal
    void sandboxPolicy
    throw new Error('RecordingFileSystem is read-only for testing; editText is forbidden.')
  }
}
