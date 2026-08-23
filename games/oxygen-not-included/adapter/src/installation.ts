import { createHash } from 'node:crypto'
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import extract from 'extract-zip'
import type { OniInstallerConfig } from './config.js'
import { compareStableVersions, steamRoots } from './steam.js'

const GAME_FOLDER = 'OxygenNotIncluded'
const MOD_FOLDER = 'DoubaoAI'
const DLL_NAME = 'DoubaoAI.ONI.dll'
const RELEASE_PREFIX = 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/'
const ASSET_PREFIX = 'dsh-xiaotangyuan-game-oni-'
const MAX_ARCHIVE_SIZE = 20 * 1024 * 1024

export interface OniArchiveSpec {
  name: string
  url: string
  size: number
  sha256: string
}

export interface OniDistributionManifest {
  schemaVersion: 1
  tag: string
  version: string
  archive: OniArchiveSpec
}

export interface OniDetection {
  found: boolean
  platform: NodeJS.Platform
  gamePath?: string
  modsPath: string
  modPath: string
  installedVersion?: string
  bridgeInstalled: boolean
}

export interface OniInstallResult {
  installed: true
  gameId: 'oxygen-not-included'
  version: string
  gamePath: string
  modPath: string
  action: 'installed' | 'updated' | 'kept'
  backupPath?: string
  components: string
  nextStep: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function defaultModsPath(): string {
  return join(homedir(), 'Documents', 'Klei', 'OxygenNotIncluded', 'mods')
}

function safeChild(parent: string, child: string): void {
  const fromParent = relative(resolve(parent), resolve(child))
  if (fromParent === '' || fromParent.startsWith('..') || isAbsolute(fromParent)) {
    throw new Error(`refusing unsafe Oxygen Not Included destination: ${child}`)
  }
}

function numericVersion(value: string): readonly number[] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function parseInstalledVersion(text: string): string | undefined {
  return text.match(/^\s*version\s*:\s*["']?([^\s"']+)/m)?.[1]?.trim()
}

async function readInstalledVersion(modPath: string): Promise<string | undefined> {
  try {
    return parseInstalledVersion(await readFile(join(modPath, 'mod_info.yaml'), 'utf8'))
  } catch {
    return undefined
  }
}

function isGameDirectory(path: string): Promise<boolean> {
  return exists(join(path, 'OxygenNotIncluded_Data', 'Managed', 'Assembly-CSharp.dll'))
}

export async function inspectOniPath(
  gamePath: string,
  modsPath = defaultModsPath(),
): Promise<OniDetection | undefined> {
  const resolvedGame = resolve(gamePath)
  if (!(await isGameDirectory(resolvedGame))) return undefined
  const resolvedMods = resolve(modsPath)
  const modPath = join(resolvedMods, 'Local', MOD_FOLDER)
  const bridgeInstalled = await exists(join(modPath, DLL_NAME))
  const installedVersion = await readInstalledVersion(modPath)
  return {
    found: true,
    platform: process.platform,
    gamePath: resolvedGame,
    modsPath: resolvedMods,
    modPath,
    bridgeInstalled,
    ...(installedVersion === undefined ? {} : { installedVersion }),
  }
}

export async function detectOni(
  gamePath?: string,
  signal?: AbortSignal,
  modsPath = defaultModsPath(),
): Promise<OniDetection> {
  signal?.throwIfAborted()
  if (gamePath !== undefined && gamePath.trim() !== '') {
    return await inspectOniPath(gamePath.trim(), modsPath)
      ?? {
        found: false,
        platform: process.platform,
        modsPath: resolve(modsPath),
        modPath: join(resolve(modsPath), 'Local', MOD_FOLDER),
        bridgeInstalled: false,
      }
  }
  for (const root of await steamRoots(signal)) {
    signal?.throwIfAborted()
    const detection = await inspectOniPath(join(root, 'steamapps', 'common', GAME_FOLDER), modsPath)
    if (detection !== undefined) return detection
  }
  return {
    found: false,
    platform: process.platform,
    modsPath: resolve(modsPath),
    modPath: join(resolve(modsPath), 'Local', MOD_FOLDER),
    bridgeInstalled: false,
  }
}

export function parseOniDistributionManifest(value: unknown): OniDistributionManifest {
  if (typeof value !== 'object' || value === null) throw new Error('缺氧发布清单不是对象')
  const manifest = value as Partial<OniDistributionManifest>
  if (manifest.schemaVersion !== 1) throw new Error('缺氧发布清单版本不受支持')
  if (typeof manifest.version !== 'string' || numericVersion(manifest.version) === undefined) {
    throw new Error('缺氧发布清单包含无效版本')
  }
  if (manifest.tag !== `oni-v${manifest.version}`) throw new Error('缺氧发布标签与版本不一致')
  if (typeof manifest.archive !== 'object' || manifest.archive === null) throw new Error('缺氧发布清单缺少安装包')
  const archive = manifest.archive as Partial<OniArchiveSpec>
  const expectedName = `${ASSET_PREFIX}${manifest.version}.zip`
  if (archive.name !== expectedName) throw new Error('缺氧安装包名称无效')
  if (archive.url !== `${RELEASE_PREFIX}${manifest.tag}/${expectedName}`) throw new Error('缺氧安装包不是官方发布地址')
  if (!Number.isSafeInteger(archive.size) || archive.size! <= 0 || archive.size! > MAX_ARCHIVE_SIZE) {
    throw new Error('缺氧安装包大小无效')
  }
  if (typeof archive.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(archive.sha256)) {
    throw new Error('缺氧安装包 SHA-256 无效')
  }
  return {
    schemaVersion: 1,
    tag: manifest.tag,
    version: manifest.version,
    archive: {
      name: archive.name,
      url: archive.url,
      size: archive.size!,
      sha256: archive.sha256.toLowerCase(),
    },
  }
}

async function fetchManifest(url: string, signal: AbortSignal): Promise<OniDistributionManifest> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-xiaotangyuan-game' },
  })
  if (!response.ok) throw new Error(`无法读取缺氧发布清单：HTTP ${response.status}`)
  return parseOniDistributionManifest(await response.json())
}

async function verifiedArchive(
  config: OniInstallerConfig,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array, version: string }> {
  let bytes: Uint8Array
  let version: string
  let expectedSha256: string
  let expectedSize: number | undefined
  if (config.archivePath !== undefined) {
    const details = await stat(config.archivePath)
    if (!details.isFile() || details.size <= 0 || details.size > MAX_ARCHIVE_SIZE) {
      throw new Error('本地缺氧安装包大小无效')
    }
    bytes = new Uint8Array(await readFile(config.archivePath))
    version = config.archiveVersion!
    expectedSha256 = config.archiveSha256!
  } else {
    const manifest = await fetchManifest(config.manifestUrl, signal)
    const response = await fetch(manifest.archive.url, {
      signal,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'dsh-xiaotangyuan-game' },
    })
    if (!response.ok) throw new Error(`下载缺氧安装包失败：HTTP ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
    version = manifest.version
    expectedSha256 = manifest.archive.sha256
    expectedSize = manifest.archive.size
  }
  if (bytes.byteLength > MAX_ARCHIVE_SIZE) throw new Error('缺氧安装包超过大小限制')
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) throw new Error('缺氧安装包大小与清单不一致')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256) throw new Error(`缺氧安装包校验失败：expected ${expectedSha256}, received ${actual}`)
  return { bytes, version }
}

async function validatePackage(packageRoot: string, expectedVersion: string): Promise<void> {
  for (const required of [DLL_NAME, 'mod.yaml', 'mod_info.yaml']) {
    if (!(await exists(join(packageRoot, required)))) throw new Error(`缺氧安装包缺少 ${required}`)
  }
  const packagedVersion = await readInstalledVersion(packageRoot)
  if (packagedVersion !== expectedVersion) {
    throw new Error(`缺氧安装包版本不一致，期望 ${expectedVersion}，实际 ${packagedVersion ?? '未知'}`)
  }
  const pending = [packageRoot]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      const details = await lstat(child)
      if (details.isSymbolicLink()) throw new Error('缺氧安装包不能包含符号链接')
      if (details.isDirectory()) pending.push(child)
    }
  }
}

async function availableBackupPath(root: string, base: string): Promise<string> {
  const initial = join(root, base)
  if (!(await exists(initial))) return initial
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = join(root, `${base}-${index}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('无法创建唯一的缺氧 Mod 备份目录')
}

export async function applyOniPackage(
  gamePath: string,
  packageRoot: string,
  version: string,
  signal: AbortSignal,
  modsPath = defaultModsPath(),
): Promise<OniInstallResult> {
  signal.throwIfAborted()
  const detection = await inspectOniPath(gamePath, modsPath)
  if (detection?.gamePath === undefined) throw new Error('指定目录不是有效的《缺氧》安装目录')
  await validatePackage(packageRoot, version)
  if (detection.installedVersion !== undefined
    && detection.bridgeInstalled
    && (compareStableVersions(detection.installedVersion, version) ?? -1) >= 0) {
    return {
      installed: true,
      gameId: 'oxygen-not-included',
      version: detection.installedVersion,
      gamePath: detection.gamePath,
      modPath: detection.modPath,
      action: 'kept',
      components: 'ONI C# Bridge + Harness 内置 TypeScript ONI Adapter',
      nextStep: '重启《缺氧》，在 Mods 中启用“缺氧 AI 精灵”。',
    }
  }

  const localRoot = join(detection.modsPath, 'Local')
  const backupRoot = join(detection.modsPath, '.xiaotangyuan-backups')
  safeChild(detection.modsPath, localRoot)
  safeChild(detection.modsPath, backupRoot)
  safeChild(localRoot, detection.modPath)
  await mkdir(localRoot, { recursive: true })
  await mkdir(backupRoot, { recursive: true })
  const stagingPath = join(localRoot, `.DoubaoAI.installing-${process.pid}-${Date.now()}`)
  safeChild(localRoot, stagingPath)
  await cp(packageRoot, stagingPath, { recursive: true, errorOnExist: true })

  let backupPath: string | undefined
  if (await exists(detection.modPath)) {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    backupPath = await availableBackupPath(backupRoot, `${MOD_FOLDER}.backup-${timestamp}`)
    safeChild(backupRoot, backupPath)
    await rename(detection.modPath, backupPath)
  }

  try {
    signal.throwIfAborted()
    await rename(stagingPath, detection.modPath)
    const installed = await inspectOniPath(detection.gamePath, detection.modsPath)
    if (installed?.installedVersion !== version || !installed.bridgeInstalled) {
      throw new Error(`缺氧 Mod 安装后验证失败，期望版本 ${version}`)
    }
    return {
      installed: true,
      gameId: 'oxygen-not-included',
      version,
      gamePath: detection.gamePath,
      modPath: installed.modPath,
      action: backupPath === undefined ? 'installed' : 'updated',
      ...(backupPath === undefined ? {} : { backupPath }),
      components: 'ONI C# Bridge + Harness 内置 TypeScript ONI Adapter',
      nextStep: '重启《缺氧》，在 Mods 中启用“缺氧 AI 精灵”。',
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    await rm(detection.modPath, { recursive: true, force: true })
    if (backupPath !== undefined && await exists(backupPath)) await rename(backupPath, detection.modPath)
    throw error
  }
}

export async function installOniMod(
  gamePath: string | undefined,
  config: OniInstallerConfig,
  signal: AbortSignal,
): Promise<OniInstallResult> {
  const detection = await detectOni(gamePath, signal)
  if (!detection.found || detection.gamePath === undefined) {
    throw new Error('没有找到《缺氧》，请通过 gamePath 提供游戏安装目录')
  }
  const archive = await verifiedArchive(config, signal)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-oni-'))
  try {
    const archivePath = join(tempRoot, 'package.zip')
    const extractedPath = join(tempRoot, 'package')
    await writeFile(archivePath, archive.bytes)
    await mkdir(extractedPath)
    await extract(archivePath, { dir: extractedPath })
    return await applyOniPackage(detection.gamePath, extractedPath, archive.version, signal)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
