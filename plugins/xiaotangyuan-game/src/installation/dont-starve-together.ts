import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import extract from 'extract-zip'
import type { ResolvedConfig } from '../config.js'
import { compareStableVersions, steamRoots } from './stardew-valley.js'

const execFileAsync = promisify(execFile)
const GAME_FOLDER = "Don't Starve Together"
const MOD_FOLDER = 'dont-starve-ai-mod'
const LAUNCHER_NAME = 'ChesterAI.exe'
const PACKAGED_INSTALLER_NAME = '安装切斯特AI.exe'
const RELEASE_PREFIX = 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/'
const ASSET_PREFIX = 'dsh-xiaotangyuan-game-dont-starve-'
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024

export interface DontStarveArchiveSpec {
  name: string
  url: string
  size: number
  sha256: string
}

export interface DontStarveDistributionManifest {
  schemaVersion: 1
  tag: string
  version: string
  archive: DontStarveArchiveSpec
}

export interface DontStarveDetection {
  found: boolean
  platform: NodeJS.Platform
  gamePath?: string
  modsPath?: string
  modPath?: string
  installedVersion?: string
  launcherInstalled: boolean
  steamLaunchOption?: string
}

export interface DontStarveInstallResult {
  installed: true
  gameId: 'dont-starve-together'
  version: string
  gamePath: string
  modPath: string
  action: 'installed' | 'updated' | 'kept'
  backupPath?: string
  steamLaunchOption: string
  components: string
}

export type DontStarveInstallerRunner = (installerPath: string, gamePath: string, signal: AbortSignal) => Promise<void>

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function numericVersion(value: string): readonly number[] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function safeChild(parent: string, child: string): void {
  const fromParent = relative(resolve(parent), resolve(child))
  if (fromParent === '' || fromParent.startsWith('..') || isAbsolute(fromParent)) {
    throw new Error(`refusing unsafe Don't Starve Together destination: ${child}`)
  }
}

function parseInstalledVersion(text: string): string | undefined {
  return text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1]?.trim()
}

async function readInstalledVersion(modPath: string): Promise<string | undefined> {
  try {
    return parseInstalledVersion(await readFile(join(modPath, 'modinfo.lua'), 'utf8'))
  } catch {
    return undefined
  }
}

export async function inspectDontStarvePath(gamePath: string): Promise<DontStarveDetection | undefined> {
  const resolved = resolve(gamePath)
  if (!(await exists(join(resolved, 'data', 'databundles', 'scripts.zip')))) return undefined
  const modsPath = join(resolved, 'mods')
  const modPath = join(modsPath, MOD_FOLDER)
  const installedVersion = await readInstalledVersion(modPath)
  const launcherPath = join(modPath, LAUNCHER_NAME)
  const launcherInstalled = await exists(launcherPath)
  return {
    found: true,
    platform: process.platform,
    gamePath: resolved,
    modsPath,
    modPath,
    launcherInstalled,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    ...(launcherInstalled ? { steamLaunchOption: `"${launcherPath}" %command%` } : {}),
  }
}

export async function detectDontStarve(
  gamePath?: string,
  signal?: AbortSignal,
): Promise<DontStarveDetection> {
  signal?.throwIfAborted()
  if (gamePath !== undefined && gamePath.trim() !== '') {
    return await inspectDontStarvePath(gamePath.trim())
      ?? { found: false, platform: process.platform, launcherInstalled: false }
  }
  for (const root of await steamRoots(signal)) {
    signal?.throwIfAborted()
    const detection = await inspectDontStarvePath(join(root, 'steamapps', 'common', GAME_FOLDER))
    if (detection !== undefined) return detection
  }
  return { found: false, platform: process.platform, launcherInstalled: false }
}

export function parseDontStarveDistributionManifest(value: unknown): DontStarveDistributionManifest {
  if (typeof value !== 'object' || value === null) throw new Error('饥荒发布清单不是对象')
  const manifest = value as Partial<DontStarveDistributionManifest>
  if (manifest.schemaVersion !== 1) throw new Error('饥荒发布清单版本不受支持')
  if (typeof manifest.version !== 'string' || numericVersion(manifest.version) === undefined) {
    throw new Error('饥荒发布清单包含无效版本')
  }
  if (manifest.tag !== `dont-starve-v${manifest.version}`) throw new Error('饥荒发布标签与版本不一致')
  if (typeof manifest.archive !== 'object' || manifest.archive === null) throw new Error('饥荒发布清单缺少安装包')
  const archive = manifest.archive as Partial<DontStarveArchiveSpec>
  const expectedName = `${ASSET_PREFIX}${manifest.version}.zip`
  if (archive.name !== expectedName) throw new Error('饥荒安装包名称无效')
  if (archive.url !== `${RELEASE_PREFIX}${manifest.tag}/${expectedName}`) throw new Error('饥荒安装包不是官方发布地址')
  if (!Number.isSafeInteger(archive.size) || archive.size! <= 0 || archive.size! > MAX_ARCHIVE_SIZE) {
    throw new Error('饥荒安装包大小无效')
  }
  if (typeof archive.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(archive.sha256)) {
    throw new Error('饥荒安装包 SHA-256 无效')
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

async function fetchManifest(url: string, signal: AbortSignal): Promise<DontStarveDistributionManifest> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-xiaotangyuan-game' },
  })
  if (!response.ok) throw new Error(`无法读取饥荒发布清单：HTTP ${response.status}`)
  return parseDontStarveDistributionManifest(await response.json())
}

async function verifiedArchive(
  config: ResolvedConfig['installers']['dontStarve'],
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array, version: string }> {
  let bytes: Uint8Array
  let version: string
  let expectedSha256: string
  let expectedSize: number | undefined
  if (config.archivePath !== undefined) {
    const details = await stat(config.archivePath)
    if (!details.isFile() || details.size <= 0 || details.size > MAX_ARCHIVE_SIZE) {
      throw new Error('本地饥荒安装包大小无效')
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
    if (!response.ok) throw new Error(`下载饥荒安装包失败：HTTP ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
    version = manifest.version
    expectedSha256 = manifest.archive.sha256
    expectedSize = manifest.archive.size
  }
  if (bytes.byteLength > MAX_ARCHIVE_SIZE) throw new Error('饥荒安装包超过大小限制')
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) throw new Error('饥荒安装包大小与清单不一致')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256) throw new Error(`饥荒安装包校验失败：expected ${expectedSha256}, received ${actual}`)
  return { bytes, version }
}

function sanitizedAdapterEnv(text: string): string {
  const allowed = /^(HARNESS_|DST_)[A-Z0-9_]*=/
  const lines = text.split(/\r?\n/).filter(line => allowed.test(line.trim()))
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

async function availableBackupPath(root: string, base: string): Promise<string> {
  const initial = join(root, base)
  if (!(await exists(initial))) return initial
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = join(root, `${base}-${index}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('无法创建唯一的饥荒 Mod 备份目录')
}

async function defaultRunner(installerPath: string, gamePath: string, signal: AbortSignal): Promise<void> {
  await execFileAsync(installerPath, ['--install'], {
    encoding: 'utf8',
    env: { ...process.env, DST_GAME_DIR: gamePath },
    windowsHide: true,
    signal,
  })
}

export async function applyDontStarveInstaller(
  gamePath: string,
  installerRoot: string,
  version: string,
  signal: AbortSignal,
  runner: DontStarveInstallerRunner = defaultRunner,
): Promise<DontStarveInstallResult> {
  const detection = await inspectDontStarvePath(gamePath)
  if (detection?.gamePath === undefined || detection.modsPath === undefined || detection.modPath === undefined) {
    throw new Error('指定目录不是有效的《饥荒联机版》安装目录')
  }
  const installerPath = join(installerRoot, PACKAGED_INSTALLER_NAME)
  if (!(await exists(installerPath))) throw new Error(`饥荒安装包缺少 ${PACKAGED_INSTALLER_NAME}`)
  if (detection.installedVersion !== undefined
    && detection.launcherInstalled
    && (compareStableVersions(detection.installedVersion, version) ?? -1) >= 0) {
    return {
      installed: true,
      gameId: 'dont-starve-together',
      version: detection.installedVersion,
      gamePath: detection.gamePath,
      modPath: detection.modPath,
      action: 'kept',
      steamLaunchOption: detection.steamLaunchOption!,
      components: 'DST Lua Mod + Harness Adapter launcher',
    }
  }

  safeChild(detection.gamePath, detection.modPath)
  const backupRoot = join(detection.gamePath, '.xiaotangyuan-backups')
  safeChild(detection.gamePath, backupRoot)
  await mkdir(backupRoot, { recursive: true })
  let previousEnv = ''
  try {
    previousEnv = sanitizedAdapterEnv(await readFile(join(detection.modPath, '.env'), 'utf8'))
  } catch {
    // A previous installation may not have Adapter configuration.
  }
  let backupPath: string | undefined
  if (await exists(detection.modPath)) {
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    backupPath = await availableBackupPath(backupRoot, `${MOD_FOLDER}.backup-${timestamp}`)
    safeChild(backupRoot, backupPath)
    await rename(detection.modPath, backupPath)
  }

  try {
    await runner(installerPath, detection.gamePath, signal)
    const installed = await inspectDontStarvePath(detection.gamePath)
    if (installed?.installedVersion !== version || !installed.launcherInstalled || installed.modPath === undefined) {
      throw new Error(`饥荒 Mod 安装后验证失败，期望版本 ${version}`)
    }
    if (previousEnv !== '') await writeFile(join(installed.modPath, '.env'), previousEnv, 'utf8')
    return {
      installed: true,
      gameId: 'dont-starve-together',
      version,
      gamePath: installed.gamePath!,
      modPath: installed.modPath,
      action: backupPath === undefined ? 'installed' : 'updated',
      ...(backupPath === undefined ? {} : { backupPath }),
      steamLaunchOption: installed.steamLaunchOption!,
      components: 'DST Lua Mod + Harness Adapter launcher',
    }
  } catch (error) {
    await rm(detection.modPath, { recursive: true, force: true })
    if (backupPath !== undefined && await exists(backupPath)) await rename(backupPath, detection.modPath)
    throw error
  }
}

export async function installDontStarveMod(
  gamePath: string | undefined,
  config: ResolvedConfig['installers']['dontStarve'],
  signal: AbortSignal,
): Promise<DontStarveInstallResult> {
  const detection = await detectDontStarve(gamePath, signal)
  if (!detection.found || detection.gamePath === undefined) {
    throw new Error('没有找到《饥荒联机版》，请通过 gamePath 提供游戏安装目录')
  }
  const archive = await verifiedArchive(config, signal)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-dont-starve-'))
  try {
    const archivePath = join(tempRoot, 'package.zip')
    const extractedPath = join(tempRoot, 'package')
    await writeFile(archivePath, archive.bytes)
    await mkdir(extractedPath)
    await extract(archivePath, { dir: extractedPath })
    return await applyDontStarveInstaller(detection.gamePath, extractedPath, archive.version, signal)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
