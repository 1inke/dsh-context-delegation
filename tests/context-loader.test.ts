import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { loadPersistentContext } from '../src/context-loader.ts'
import { RecordingFileSystem } from './support/recording-file-system.ts'

describe('W2-4 loadPersistentContext', () => {
  it('loads all 6 fixed context files in priority order when present', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setDirectory('/workspace/harness')
    fs.setDirectory('/workspace/harness/context')

    fs.setFile('/workspace/AGENTS.md', '# AGENTS')
    fs.setFile('/workspace/harness/context/CURRENT_STATE.md', '# CURRENT_STATE\r\nline2')
    fs.setFile('/workspace/harness/context/PROJECT_CONTEXT.md', '# PROJECT_CONTEXT')
    fs.setFile('/workspace/harness/context/CODEX_HANDOFF.md', '# CODEX_HANDOFF')
    fs.setFile('/workspace/harness/context/DECISIONS.md', '# DECISIONS')
    fs.setFile('/workspace/harness/context/EXPERIMENTS.md', '# EXPERIMENTS')

    const config = resolveConfig()
    const controller = new AbortController()

    const bundle = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: '/workspace',
      signal: controller.signal,
    })

    expect(bundle.workspaceRoot).toBe('/workspace')
    expect(bundle.files.map(f => f.id)).toEqual([
      'agents',
      'currentState',
      'projectContext',
      'handoffRules',
      'decisions',
      'experiments',
    ])
    expect(bundle.files[1]!.content).toBe('# CURRENT_STATE\nline2') // CRLF normalized to LF
    expect(bundle.missingFiles).toEqual([])
    expect(bundle.truncatedFiles).toEqual([])
    expect(bundle.warning).toBeUndefined()
  })

  it('records missing files in missingFiles without failing', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/AGENTS.md', '# AGENTS')

    const config = resolveConfig()
    const controller = new AbortController()

    const bundle = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: '/workspace',
      signal: controller.signal,
    })

    expect(bundle.files.length).toBe(1)
    expect(bundle.files[0]!.id).toBe('agents')
    expect(bundle.missingFiles).toEqual([
      'harness/context/CURRENT_STATE.md',
      'harness/context/PROJECT_CONTEXT.md',
      'harness/context/CODEX_HANDOFF.md',
      'harness/context/DECISIONS.md',
      'harness/context/EXPERIMENTS.md',
    ])
    expect(bundle.warning).toBeUndefined()
  })

  it('emits a warning when all planned files are missing', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')

    const config = resolveConfig()
    const controller = new AbortController()

    const bundle = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: '/workspace',
      signal: controller.signal,
    })

    expect(bundle.files.length).toBe(0)
    expect(bundle.missingFiles.length).toBe(6)
    expect(bundle.warning).toBe('No persistent context files found in workspace')
  })

  it('throws CONTEXT_READ_ERROR if a planned path is a directory', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setDirectory('/workspace/AGENTS.md') // directory instead of file!

    const config = resolveConfig()
    const controller = new AbortController()

    await expect(
      loadPersistentContext({
        fs,
        config,
        workspaceRoot: '/workspace',
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_READ_ERROR]')

    try {
      await loadPersistentContext({
        fs,
        config,
        workspaceRoot: '/workspace',
        signal: controller.signal,
      })
    } catch (err: any) {
      expect(err.message).toContain('Expected file but found directory')
      expect(err.details.layer).toBe('context')
    }
  })

  it('throws CONTEXT_READ_ERROR on unreadable file or disk I/O failure', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/AGENTS.md', '# AGENTS')
    fs.setFailure('streamText:/workspace/AGENTS.md', new Error('EACCES: permission denied'))

    const config = resolveConfig()
    const controller = new AbortController()

    await expect(
      loadPersistentContext({
        fs,
        config,
        workspaceRoot: '/workspace',
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_READ_ERROR]')
  })

  it('throws CONTEXT_PATH_ESCAPE if a context file symlinks outside workspace', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/outside/secret.md', 'secret')
    fs.setSymlink('/workspace/AGENTS.md', '/outside/secret.md')

    const config = resolveConfig()
    const controller = new AbortController()

    await expect(
      loadPersistentContext({
        fs,
        config,
        workspaceRoot: '/workspace',
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_PATH_ESCAPE]')
  })

  it('throws CONTEXT_TOO_LARGE if Priority 1 exceeds maxContextChars', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/AGENTS.md', 'A'.repeat(500))

    const config = resolveConfig({ maxContextChars: 200 })
    const controller = new AbortController()

    await expect(
      loadPersistentContext({
        fs,
        config,
        workspaceRoot: '/workspace',
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_TOO_LARGE]')
  })

  it('maps AbortSignal to CODEX_CANCELLED when aborted', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/AGENTS.md', '# AGENTS')

    const config = resolveConfig()
    const controller = new AbortController()
    controller.abort()

    await expect(
      loadPersistentContext({
        fs,
        config,
        workspaceRoot: '/workspace',
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CODEX_CANCELLED]')
  })

  it('strictly restricts file operations to planned whitelist paths', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/AGENTS.md', '# AGENTS')
    fs.setFile('/workspace/.env', 'SECRET=123')
    fs.setFile('/workspace/package.json', '{}')

    const config = resolveConfig()
    const controller = new AbortController()

    await loadPersistentContext({
      fs,
      config,
      workspaceRoot: '/workspace',
      signal: controller.signal,
    })

    // Confirm that .env and package.json were NEVER resolved or read!
    const resolvedPaths = fs.calls.filter(c => c.method === 'resolve').map(c => c.path)
    expect(resolvedPaths).not.toContain('.env')
    expect(resolvedPaths).not.toContain('package.json')
  })

  it('uses bounded streaming and stops after maxContextChars + 1 normalized characters', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setStreamChunks('/workspace/harness/context/CURRENT_STATE.md', [
      'A'.repeat(80),
      'B'.repeat(80),
      'C'.repeat(80),
    ])
    const config = resolveConfig({
      maxContextChars: 120,
      includeAgents: false,
      includeProjectContext: false,
      includeHandoffRules: false,
      includeDecisions: false,
      includeExperiments: false,
    })

    const result = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: '/workspace',
      signal: new AbortController().signal,
    })

    expect(result.totalChars).toBe(120)
    expect(result.files[0]!.originalChars).toBeNull()
    expect(result.files[0]!.truncated).toBe(true)
    expect(fs.calls.filter(call => call.method === 'streamChunk')).toHaveLength(2)
    expect(fs.calls.some(call => call.method === 'readText')).toBe(false)
  })

  it('normalizes CRLF correctly when the pair crosses stream chunk boundaries', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setStreamChunks('/workspace/AGENTS.md', ['line 1\r', '\nline 2\r', 'line 3'])
    const config = resolveConfig({
      maxContextChars: 100,
      includeCurrentState: false,
      includeProjectContext: false,
      includeHandoffRules: false,
      includeDecisions: false,
      includeExperiments: false,
    })

    const result = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: '/workspace',
      signal: new AbortController().signal,
    })

    expect(result.files[0]!.content).toBe('line 1\nline 2\nline 3')
    expect(result.files[0]!.originalChars).toBe(20)
  })

  it('rejects a missing or non-directory workspace before candidate reads', async () => {
    const missingFs = new RecordingFileSystem()
    await expect(loadPersistentContext({
      fs: missingFs,
      config: resolveConfig(),
      workspaceRoot: '/missing',
      signal: new AbortController().signal,
    })).rejects.toThrow('[WORKSPACE_NOT_FOUND]')

    const fileFs = new RecordingFileSystem().setFile('/not-a-directory', 'x')
    await expect(loadPersistentContext({
      fs: fileFs,
      config: resolveConfig(),
      workspaceRoot: '/not-a-directory',
      signal: new AbortController().signal,
    })).rejects.toThrow('[WORKSPACE_NOT_FOUND]')
  })
})
