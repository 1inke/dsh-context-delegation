import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('package surface', () => {
  it('keeps Host and scoped tool entrypoints separate', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')) as {
      main: string
      license: string
      exports: Record<string, unknown>
      dsh: { bundle: { patch: string } }
      devDependencies: Record<string, string>
    }
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.license).toBe('MIT')
    expect(manifest.exports).toHaveProperty('.')
    expect(manifest.exports).toHaveProperty('./tool')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.devDependencies['@deepseek-ai/dsh-fs-local']).toBe('0.1.5-rc.2')
  })

  it('mounts only the Host entry from the bundle patch', async () => {
    const patch = await readFile(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: dsh-context-delegation')
    expect(patch).not.toContain('dsh-context-delegation/tool')
    expect(patch).not.toContain('codex_expert')
  })
})
