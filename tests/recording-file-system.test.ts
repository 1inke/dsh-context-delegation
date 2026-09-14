import { describe, expect, it } from 'vitest'
import { RecordingFileSystem } from './support/recording-file-system.ts'

describe('W2-1 RecordingFileSystem', () => {
  it('resolves, stats, and reads in-memory files', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/AGENTS.md', '# Agent Instructions')

    const target = await fs.resolve('AGENTS.md', { cwd: '/workspace' })
    expect(target.displayPath).toBe('/workspace/AGENTS.md')

    const info = await fs.stat(target)
    expect(info).toBeDefined()
    expect(info?.type).toBe('file')
    expect(info?.size).toBe('# Agent Instructions'.length)

    const content = await fs.readText(target)
    expect(content).toBe('# Agent Instructions')

    expect(fs.calls.some(c => c.method === 'resolve' && c.path === 'AGENTS.md')).toBe(true)
    expect(fs.calls.some(c => c.method === 'stat' && c.targetKey === '/workspace/AGENTS.md')).toBe(true)
    expect(fs.calls.some(c => c.method === 'readText' && c.targetKey === '/workspace/AGENTS.md')).toBe(true)
  })

  it('correctly reports containment for inside and outside targets', async () => {
    const fs = new RecordingFileSystem()
    const workspace = await fs.resolve('/workspace')
    const inside = await fs.resolve('/workspace/sub/file.txt')
    const outside = await fs.resolve('/etc/passwd')

    expect(fs.contains(workspace, inside)).toBe(true)
    expect(fs.contains(workspace, workspace)).toBe(true)
    expect(fs.contains(workspace, outside)).toBe(false)
  })

  it('records AbortSignal and throws FS_ABORTED when aborted', async () => {
    const fs = new RecordingFileSystem()
    fs.setFile('/workspace/file.txt', 'hello')

    const controller = new AbortController()
    const signal = controller.signal

    // Call with active signal
    const target = await fs.resolve('file.txt', { cwd: '/workspace', signal })
    expect(fs.calls.find(c => c.method === 'resolve')?.signal).toBe(signal)

    // Abort controller
    controller.abort()
    let error: any
    try {
      await fs.readText(target, signal)
    } catch (err) {
      error = err
    }
    expect(error?.code).toBe('FS_ABORTED')
  })

  it('handles symlinks: inside vs outside canonical targets', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace')
    fs.setFile('/workspace/real.md', 'real content')
    fs.setSymlink('/workspace/link-inside.md', '/workspace/real.md')
    fs.setSymlink('/workspace/link-outside.md', '/secret/key.pem')

    const workspace = await fs.resolve('/workspace')
    const insideLink = await fs.resolve('link-inside.md', { cwd: '/workspace' })
    const outsideLink = await fs.resolve('link-outside.md', { cwd: '/workspace' })

    expect(insideLink.displayPath).toBe('/workspace/real.md')
    expect(outsideLink.displayPath).toBe('/secret/key.pem')

    expect(fs.contains(workspace, insideLink)).toBe(true)
    expect(fs.contains(workspace, outsideLink)).toBe(false)

    // lstat reports symlink on raw path
    const lstatInside = await fs.lstat('link-inside.md', { cwd: '/workspace' })
    expect(lstatInside?.type).toBe('symlink')
  })

  it('throws when writeText or editText is attempted', async () => {
    const fs = new RecordingFileSystem()
    const target = await fs.resolve('/workspace/file.txt')
    await expect(fs.writeText(target, 'new content')).rejects.toThrow('writeText is forbidden')
    await expect(
      fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }),
    ).rejects.toThrow('editText is forbidden')
  })

  it('simulates missing files, directories, and custom failures', async () => {
    const fs = new RecordingFileSystem()
    fs.setDirectory('/workspace/dir')
    fs.setFailure('readText:/workspace/broken.txt', new Error('Disk error'))

    const missingTarget = await fs.resolve('/workspace/missing.txt')
    expect(await fs.stat(missingTarget)).toBeUndefined()
    await expect(fs.readText(missingTarget)).rejects.toThrow('File not found')

    const dirTarget = await fs.resolve('/workspace/dir')
    const dirInfo = await fs.stat(dirTarget)
    expect(dirInfo?.type).toBe('directory')
    await expect(fs.readText(dirTarget)).rejects.toThrow('Target is not a file')

    fs.setFile('/workspace/broken.txt', 'data')
    const brokenTarget = await fs.resolve('/workspace/broken.txt')
    await expect(fs.readText(brokenTarget)).rejects.toThrow('Disk error')
  })
})
