import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { collectWorkspaceEvidence, classifyGitError } from '../src/workspace-evidence.ts'

const exec = promisify(execFile)

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function createGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v04-evidence-'))
  dirs.push(root)
  await exec('git', ['init', '-b', 'main'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.test'], { cwd: root })
  await exec('git', ['config', 'user.name', 'test'], { cwd: root })
  await writeFile(join(root, 'widget.ts'), 'export const color = "blue"\n')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['commit', '-m', 'baseline'], { cwd: root })
  return root
}

describe('collectWorkspaceEvidence (real git)', () => {
  it('collects changed files and a diff summary from a real git workspace', async () => {
    const root = await createGitRepo()
    await writeFile(join(root, 'widget.ts'), 'export const color = "red"\n')
    await writeFile(join(root, 'new-file.txt'), 'untracked\n')

    const evidence = await collectWorkspaceEvidence({ workspaceRoot: root })

    expect(evidence.available).toBe(true)
    expect(evidence.filesChanged).toContain('widget.ts')
    expect(evidence.filesChanged).toContain('new-file.txt')
    expect(evidence.diffSummary).toBeTruthy()
  }, 20000)

  it('reports unavailable (not fabricated) evidence for a non-git directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-v04-evidence-nogit-'))
    dirs.push(root)
    await writeFile(join(root, 'plain.txt'), 'no repo here\n')

    const evidence = await collectWorkspaceEvidence({ workspaceRoot: root })

    expect(evidence.available).toBe(false)
    expect(evidence.reason).toBeTruthy()
    expect(evidence.filesChanged).toEqual([])
  })

  it('normalizes changed paths to forward slashes', async () => {
    const root = await createGitRepo()
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'deep.txt'), 'created\n')

    const evidence = await collectWorkspaceEvidence({ workspaceRoot: root })

    expect(evidence.available).toBe(true)
    expect(evidence.filesChanged).toContain('nested/deep.txt')
    expect(evidence.filesChanged.some(path => path.includes('\\'))).toBe(false)
  })

  it('caps the changed-file list at a bounded ceiling', async () => {
    const root = await createGitRepo()
    for (let index = 0; index < 600; index++) {
      await writeFile(join(root, `generated-${index}.txt`), `${index}\n`)
    }

    const evidence = await collectWorkspaceEvidence({ workspaceRoot: root })

    expect(evidence.available).toBe(true)
    expect(evidence.filesChanged.length).toBeLessThanOrEqual(500)
    expect(evidence.filesChanged.length).toBeGreaterThan(0)
  })

  it('rejects with CODEX_CANCELLED when the signal is already aborted', async () => {
    const root = await createGitRepo()
    const controller = new AbortController()
    controller.abort()

    await expect(collectWorkspaceEvidence({ workspaceRoot: root, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CODEX_CANCELLED' })
  })

  it('collects evidence from a repository with different ownership (canary fixture)', async () => {
    const fixtureRoot = process.env.DSH_CANARY_FIXTURE_PATH || 'v1-web-canary-fixture'
    try {
      await access(fixtureRoot)
    } catch {
      return
    }
    const evidence = await collectWorkspaceEvidence({ workspaceRoot: fixtureRoot })
    expect(evidence.available).toBe(true)
    expect(evidence.filesChanged).toContain('canary-output.txt')
  })
})

describe('classifyGitError', () => {
  it('classifies ENOENT as binary not found', () => {
    const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    expect(classifyGitError(error)).toBe('git binary not found (ENOENT)')
  })

  it('classifies EPERM/EACCES as access denied', () => {
    const error = Object.assign(new Error('spawn git EPERM'), { code: 'EPERM' })
    expect(classifyGitError(error)).toBe('git access denied (EPERM)')
  })

  it('classifies timeouts', () => {
    const error = new Error('Command timed out after 30000ms')
    expect(classifyGitError(error)).toBe('git command timed out')
  })

  it('classifies dubious ownership', () => {
    const error = new Error('fatal: detected dubious ownership in repository at ...')
    expect(classifyGitError(error)).toBe('git dubious ownership detected')
  })

  it('classifies not a git repository', () => {
    const error = new Error('fatal: not a git repository (or any of the parent directories): .git')
    expect(classifyGitError(error)).toBe('not a git work tree')
  })

  it('sanitizes and truncates generic git failures', () => {
    const error = new Error('fatal: some unexpected git internal failure\nadditional details...')
    expect(classifyGitError(error)).toBe('git error: fatal: some unexpected git internal failure')
  })
})
