import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { loadPersistentContext } from '../src/context-loader.ts'
import { validateRelevantFiles } from '../src/path-confinement.ts'

describe('W2-6 Real filesystem and symlink security tests', () => {
  let tempBase: string
  let workspaceDir: string
  let outsideDir: string
  let ctx: Context
  let localFs: LocalFileSystem
  let fs: FileSystem

  beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'dsh-fs-test-'))
    workspaceDir = join(tempBase, 'workspace')
    outsideDir = join(tempBase, 'outside')

    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    ctx = new Context()
    localFs = new LocalFileSystem(ctx, {
      cwd: workspaceDir,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    })
    fs = localFs as unknown as FileSystem
  })

  afterEach(async () => {
    if (tempBase) {
      await rm(tempBase, { recursive: true, force: true })
    }
  })

  it('loads real workspace context files on disk using LocalFileSystem', async () => {
    const contextDir = join(workspaceDir, 'harness', 'context')
    await mkdir(contextDir, { recursive: true })

    await writeFile(join(workspaceDir, 'AGENTS.md'), '# Real Agents\r\nRule 1', 'utf8')
    await writeFile(join(contextDir, 'CURRENT_STATE.md'), '# Real Current State', 'utf8')

    const config = resolveConfig()
    const controller = new AbortController()

    const result = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: workspaceDir,
      signal: controller.signal,
    })

    expect(result.files.length).toBe(2)
    expect(result.files[0]!.id).toBe('agents')
    expect(result.files[0]!.content).toBe('# Real Agents\nRule 1')
    expect(result.files[1]!.id).toBe('currentState')
    expect(result.files[1]!.content).toBe('# Real Current State')
    expect(result.missingFiles.length).toBe(4)
  })

  it('bounds memory by streaming only a prefix of an oversized real context file', async () => {
    const contextDir = join(workspaceDir, 'harness', 'context')
    await mkdir(contextDir, { recursive: true })
    await writeFile(join(contextDir, 'CURRENT_STATE.md'), 'X'.repeat(2_000_000), 'utf8')

    const config = resolveConfig({
      maxContextChars: 1_000,
      includeAgents: false,
      includeProjectContext: false,
      includeHandoffRules: false,
      includeDecisions: false,
      includeExperiments: false,
    })
    const result = await loadPersistentContext({
      fs,
      config,
      workspaceRoot: workspaceDir,
      signal: new AbortController().signal,
    })

    expect(result.totalChars).toBe(1_000)
    expect(result.files[0]!.truncated).toBe(true)
    expect(result.files[0]!.originalChars).toBeNull()
  })

  it('rejects a nonexistent real workspace as WORKSPACE_NOT_FOUND', async () => {
    await expect(loadPersistentContext({
      fs,
      config: resolveConfig(),
      workspaceRoot: join(tempBase, 'missing-workspace'),
      signal: new AbortController().signal,
    })).rejects.toThrow('[WORKSPACE_NOT_FOUND]')
  })

  it('rejects directory junction pointing outside workspace (Junction Escape)', async () => {
    // outside has real context
    const outsideContext = join(outsideDir, 'external-context')
    await mkdir(outsideContext, { recursive: true })
    await writeFile(join(outsideContext, 'CURRENT_STATE.md'), '# SECRET OUTSIDE DATA', 'utf8')

    // workspace has junction pointing to outside directory
    const workspaceHarness = join(workspaceDir, 'harness')
    await mkdir(workspaceHarness, { recursive: true })
    const linkDir = join(workspaceHarness, 'context')

    await symlink(outsideContext, linkDir, 'junction')

    const config = resolveConfig()
    const controller = new AbortController()

    await expect(
      loadPersistentContext({
        fs,
        config,
        workspaceRoot: workspaceDir,
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_PATH_ESCAPE]')
  })

  it('rejects relevant_files resolving through outside directory junction', async () => {
    const outsideTarget = join(outsideDir, 'target-dir')
    await mkdir(outsideTarget, { recursive: true })
    await writeFile(join(outsideTarget, 'secret.key'), 'SUPER_SECRET', 'utf8')

    const junctionInWorkspace = join(workspaceDir, 'outside-link')
    await symlink(outsideTarget, junctionInWorkspace, 'junction')

    const controller = new AbortController()

    await expect(
      validateRelevantFiles({
        fs,
        workspaceRoot: workspaceDir,
        relevantFiles: ['outside-link/secret.key'],
        signal: controller.signal,
      }),
    ).rejects.toThrow('[CONTEXT_PATH_ESCAPE]')
  })

  it('handles Windows backslash separators and relative normalization on real disk', async () => {
    const srcDir = join(workspaceDir, 'src', 'deep')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'index.ts'), 'export const val = 42;', 'utf8')

    const controller = new AbortController()

    const validated = await validateRelevantFiles({
      fs,
      workspaceRoot: workspaceDir,
      relevantFiles: ['.\\src\\deep\\index.ts', 'src/deep/index.ts'],
      signal: controller.signal,
    })

    expect(validated).toEqual(['src/deep/index.ts'])
  })

  it('reports Windows file symlink creation or validates containment when supported', async () => {
    const targetFile = join(outsideDir, 'secret-file.txt')
    await writeFile(targetFile, 'OUTSIDE_SECRET', 'utf8')

    const linkFile = join(workspaceDir, 'link-secret.txt')

    let symlinkCreated = false
    let symlinkError: string | null = null

    try {
      await symlink(targetFile, linkFile, 'file')
      symlinkCreated = true
    } catch (err: any) {
      symlinkError = err.message
    }

    const controller = new AbortController()

    if (symlinkCreated) {
      await expect(
        validateRelevantFiles({
          fs,
          workspaceRoot: workspaceDir,
          relevantFiles: ['link-secret.txt'],
          signal: controller.signal,
        }),
      ).rejects.toThrow('[CONTEXT_PATH_ESCAPE]')
    } else {
      // Must give clear Windows reason (e.g. EPERM without Developer Mode), not silent pass
      expect(symlinkError).toMatch(/EPERM|operation not permitted/i)
    }
  })
})
