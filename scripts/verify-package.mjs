import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32'
  ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
  : 'npm'
const npmArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm pack --dry-run --ignore-scripts --json']
  : ['pack', '--dry-run', '--ignore-scripts', '--json']

const cacheDir = resolve(packageRoot, 'node_modules/.cache')
mkdirSync(cacheDir, { recursive: true })
const tempOutputFile = resolve(cacheDir, `npm-pack-output-${Date.now()}.json`)
const outFd = openSync(tempOutputFile, 'w')

let packOutput
try {
  try {
    execFileSync(
      npmCommand,
      npmArgs,
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          npm_config_cache: resolve(cacheDir, 'npm-pack-verify'),
        },
        stdio: ['ignore', outFd, 'inherit'],
      },
    )
  } finally {
    closeSync(outFd)
  }
  packOutput = readFileSync(tempOutputFile, 'utf8')
} catch (error) {
  const detail = error?.stderr?.toString().trim() || error?.message || String(error)
  throw new Error(`npm pack dry-run failed: ${detail}`)
} finally {
  try {
    unlinkSync(tempOutputFile)
  } catch {
    // ignore cleanup error
  }
}

const report = JSON.parse(packOutput)
const entries = report[0]?.files
if (!Array.isArray(entries)) throw new Error('npm pack dry-run returned no file inventory')

const packedFiles = new Set(entries.map((entry) => posix.normalize(entry.path)))
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
const exportTargets = Object.values(packageJson.exports)
  .flatMap((value) => (typeof value === 'string' ? [value] : Object.values(value)))
  .filter((value) => typeof value === 'string' && value.startsWith('./'))
  .map((value) => posix.normalize(value.slice(2)))

for (const target of exportTargets) {
  if (!packedFiles.has(target)) throw new Error(`package export is missing from tarball: ${target}`)
}

const relativeImportPattern = /(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g
for (const file of [...packedFiles].filter((entry) => entry.endsWith('.js'))) {
  const source = readFileSync(resolve(packageRoot, file), 'utf8')
  for (const match of source.matchAll(relativeImportPattern)) {
    const specifier = match[1]
    if (!specifier || !specifier.endsWith('.js')) continue
    const target = posix.normalize(posix.join(posix.dirname(file), specifier))
    if (!packedFiles.has(target)) {
      throw new Error(`packed JavaScript ${file} imports missing tarball file ${target}`)
    }
  }
}

process.stdout.write(`Verified ${packedFiles.size} packed files and all relative JavaScript imports.\n`)
