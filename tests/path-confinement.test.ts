import { describe, expect, it } from 'vitest'
import { ContextDelegationError } from '../src/errors.ts'
import { normalizeRelativePath, validateRelevantFiles } from '../src/path-confinement.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'

describe('W2-3 normalizeRelativePath', () => {
  it('normalizes valid relative paths to POSIX slashes and removes leading ./', () => {
    expect(normalizeRelativePath('./src/app.ts')).toBe('src/app.ts')
    expect(normalizeRelativePath('src\\utils\\helper.ts')).toBe('src/utils/helper.ts')
    expect(normalizeRelativePath('a/b/../c/./d.ts')).toBe('a/c/d.ts')
  })

  it('rejects empty, absolute, drive-letter, UNC, and escaping paths', () => {
    expect(() => normalizeRelativePath('')).toThrow(ContextDelegationError)
    expect(() => normalizeRelativePath('   ')).toThrow(ContextDelegationError)
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('\\Windows\\System32')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('C:\\secret.key')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('d:/foo/bar')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('\\\\server\\share\\file')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('../escape.txt')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('a/../../escape.txt')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('.')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath(' leading.ts')).toThrow('[CONTEXT_PATH_ESCAPE]')
    expect(() => normalizeRelativePath('trailing.ts ')).toThrow('[CONTEXT_PATH_ESCAPE]')
  })
})

describe('W2-3 validateRelevantFiles', () => {
  it('validates, normalizes, and deduplicates existing and new relative files', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setDirectory('/workspace/src')
    fs.setFile('/workspace/src/index.ts', 'console.log("hello")')
    fs.setFile('/workspace/README.md', '# Readme')

    const controller = new AbortController()
    const result = await validateRelevantFiles({
      fs,
      workspaceRoot: '/workspace',
      relevantFiles: [
        './src/index.ts',
        'README.md',
        'src\\index.ts', // duplicate after normalization
        'src/new-feature.ts', // does not exist yet; valid for new file creation
      ],
      signal: controller.signal,
    })

    expect(result).toEqual(['src/index.ts', 'README.md', 'src/new-feature.ts'])

    // Critical Invariant: readText is NEVER called on relevant_files!
    expect(fs.calls.some(c => c.method === 'readText')).toBe(false)
  })

  it('rejects paths that resolve outside workspace with CONTEXT_PATH_ESCAPE', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/outside.txt', 'secret')
    fs.setSymlink('/workspace/link-to-outside.txt', '/outside.txt')

    const controller = new AbortController()

    // Symlink pointing outside workspace
    await expect(
      validateRelevantFiles({
        fs,
        workspaceRoot: '/workspace',
        relevantFiles: ['link-to-outside.txt'],
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_PATH_ESCAPE]')
  })

  it('rejects directory targets with CONTEXT_READ_ERROR', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setDirectory('/workspace/src')

    const controller = new AbortController()

    await expect(
      validateRelevantFiles({
        fs,
        workspaceRoot: '/workspace',
        relevantFiles: ['src'],
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_READ_ERROR]')

    try {
      await validateRelevantFiles({
        fs,
        workspaceRoot: '/workspace',
        relevantFiles: ['src'],
        signal: controller.signal,
      })
    } catch (err: any) {
      expect(err.message).toContain('is a directory, not a file')
      expect(err.details.layer).toBe('context')
    }
  })

  it('rejects special non-regular files with CONTEXT_READ_ERROR', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setOther('/workspace/pipe.sock')

    const controller = new AbortController()

    await expect(
      validateRelevantFiles({
        fs,
        workspaceRoot: '/workspace',
        relevantFiles: ['pipe.sock'],
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_READ_ERROR]')
  })

  it('maps AbortSignal cancellation to CODEX_CANCELLED', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/a.ts', 'content')

    const controller = new AbortController()
    controller.abort()

    await expect(
      validateRelevantFiles({
        fs,
        workspaceRoot: '/workspace',
        relevantFiles: ['a.ts'],
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CODEX_CANCELLED]')
  })

  it('deduplicates Windows case-equivalent paths before filesystem access', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('C:/workspace')
    fs.setFile('C:/workspace/src/File.ts', 'content')

    const result = await validateRelevantFiles({
      fs,
      workspaceRoot: 'C:/workspace',
      relevantFiles: ['src/File.ts', 'SRC/file.ts'],
      signal: new AbortController().signal,
    })

    expect(result).toEqual(['src/File.ts'])
    const candidateResolves = fs.calls.filter(call => call.method === 'resolve' && call.path !== '.')
    expect(candidateResolves).toHaveLength(1)
  })

  it('deduplicates different lexical aliases of the same canonical target', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/source.ts', 'content')
    fs.aliases.set('/workspace/alias.ts', '/workspace/source.ts')

    const result = await validateRelevantFiles({
      fs,
      workspaceRoot: '/workspace',
      relevantFiles: ['source.ts', 'alias.ts'],
      signal: new AbortController().signal,
    })

    expect(result).toEqual(['source.ts'])
  })
})
