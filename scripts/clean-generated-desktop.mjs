import { rmSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactRoot = resolve(repoRoot, '.artifacts')
const target = resolve(process.argv[2] ?? '')
const allowedNames = new Set(['desktop-app', 'desktop-runtime'])

if (!target.startsWith(`${artifactRoot}${sep}`) || !allowedNames.has(target.slice(artifactRoot.length + 1))) {
  throw new Error(`Refusing to remove unsafe generated path: ${target}`)
}

rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
