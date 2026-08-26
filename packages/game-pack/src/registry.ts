import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertGamePackManifest, type GamePackManifest } from './index.js'

export const GAME_PACK_MANIFEST = 'game-pack.json'
const INSTALL_METADATA = '.harness-install.json'
const MAX_PACK_FILES = 2_000
const MAX_PACK_BYTES = 256 * 1024 * 1024
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

export interface InstalledGamePack {
  manifest: GamePackManifest
  installedAt: string
  root: string
  health: 'ready'
}

export interface LoadedGamePackContent {
  story?: string
  characters?: string
  gameplay?: string
  localization?: string
}

function assertPackId(id: string): void {
  assertGamePackManifest({
    schemaVersion: 1,
    id,
    version: '0.0.0',
    displayName: 'validation',
    adapter: { id: 'validation', entry: 'adapter', protocolVersion: '1.0' },
    content: {},
  })
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function scanSafeTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`Game Pack cannot contain symbolic links: ${relative(root, path)}`)
      if (info.isDirectory()) {
        await visit(path)
        continue
      }
      if (!info.isFile()) throw new Error(`Game Pack contains an unsupported file type: ${relative(root, path)}`)
      files += 1
      bytes += info.size
      if (files > MAX_PACK_FILES) throw new Error(`Game Pack exceeds ${MAX_PACK_FILES} files`)
      if (bytes > MAX_PACK_BYTES) throw new Error(`Game Pack exceeds ${MAX_PACK_BYTES} bytes`)
    }
  }
  await visit(root)
}

async function requiredFile(root: string, path: string, label: string): Promise<string> {
  const target = resolve(root, path)
  if (!inside(root, target)) throw new Error(`${label} leaves the Game Pack root`)
  const info = await lstat(target).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} does not reference a regular file: ${path}`)
  return target
}

export async function readGamePackManifest(root: string): Promise<GamePackManifest> {
  const absoluteRoot = resolve(root)
  const raw = await readFile(join(absoluteRoot, GAME_PACK_MANIFEST), 'utf8')
  const manifest = JSON.parse(raw) as GamePackManifest
  assertGamePackManifest(manifest)
  await requiredFile(absoluteRoot, manifest.adapter.entry, 'adapter.entry')
  for (const [key, path] of Object.entries(manifest.content)) {
    if (path) await requiredFile(absoluteRoot, path, `content.${key}`)
  }
  for (const [index, path] of (manifest.assets ?? []).entries()) {
    await requiredFile(absoluteRoot, path, `assets[${index}]`)
  }
  return manifest
}

export class GamePackRegistry {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async list(): Promise<InstalledGamePack[]> {
    await mkdir(this.root, { recursive: true })
    const installed: InstalledGamePack[] = []
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const packRoot = join(this.root, entry.name)
      try {
        const manifest = await readGamePackManifest(packRoot)
        if (manifest.id !== entry.name) continue
        const metadata = JSON.parse(await readFile(join(packRoot, INSTALL_METADATA), 'utf8').catch(() => '{}')) as { installedAt?: unknown }
        installed.push({
          manifest,
          installedAt: typeof metadata.installedAt === 'string' ? metadata.installedAt : '',
          root: packRoot,
          health: 'ready',
        })
      } catch {
        // A partial or externally modified directory is never reported as ready.
      }
    }
    return installed.sort((left, right) => left.manifest.displayName.localeCompare(right.manifest.displayName))
  }

  async get(id: string): Promise<InstalledGamePack | undefined> {
    assertPackId(id)
    return (await this.list()).find(pack => pack.manifest.id === id)
  }

  async install(sourceRoot: string, options: { replace?: boolean } = {}): Promise<InstalledGamePack> {
    const source = resolve(sourceRoot)
    await scanSafeTree(source)
    const manifest = await readGamePackManifest(source)
    await mkdir(this.root, { recursive: true })
    const destination = join(this.root, manifest.id)
    const staging = join(this.root, `.staging-${manifest.id}-${randomUUID()}`)
    const backup = join(this.root, `.backup-${manifest.id}-${randomUUID()}`)
    const existing = await lstat(destination).catch(() => undefined)
    if (existing && !options.replace) throw new Error(`Game Pack is already installed: ${manifest.id}`)

    let backedUp = false
    try {
      await cp(source, staging, { recursive: true, errorOnExist: true, force: false })
      const installedAt = new Date().toISOString()
      await writeFile(join(staging, INSTALL_METADATA), `${JSON.stringify({ installedAt }, null, 2)}\n`, 'utf8')
      await readGamePackManifest(staging)
      if (existing) {
        await rename(destination, backup)
        backedUp = true
      }
      await rename(staging, destination)
      if (backedUp) await rm(backup, { recursive: true, force: true })
      return { manifest, installedAt, root: destination, health: 'ready' }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (backedUp) {
        await rm(destination, { recursive: true, force: true }).catch(() => undefined)
        await rename(backup, destination).catch(() => undefined)
      }
      throw error
    }
  }

  async uninstall(id: string, expectedVersion?: string): Promise<boolean> {
    assertPackId(id)
    const installed = await this.get(id)
    if (!installed) return false
    if (expectedVersion !== undefined && installed.manifest.version !== expectedVersion) {
      throw new Error(`Game Pack version changed: expected ${expectedVersion}, found ${installed.manifest.version}`)
    }
    const destination = resolve(this.root, id)
    if (!inside(this.root, destination) || destination === this.root) throw new Error('Unsafe Game Pack uninstall target')
    await rm(destination, { recursive: true, force: false })
    return true
  }

  async loadContent(id: string): Promise<LoadedGamePackContent> {
    const installed = await this.get(id)
    if (!installed) throw new Error(`Game Pack is not installed: ${id}`)
    const content: LoadedGamePackContent = {}
    for (const [key, path] of Object.entries(installed.manifest.content)) {
      if (!path) continue
      const file = await requiredFile(installed.root, path, `content.${key}`)
      const info = await lstat(file)
      if (info.size > MAX_CONTENT_BYTES) throw new Error(`Game Pack content is too large: ${key}`)
      content[key as keyof LoadedGamePackContent] = await readFile(file, 'utf8')
    }
    return content
  }
}
