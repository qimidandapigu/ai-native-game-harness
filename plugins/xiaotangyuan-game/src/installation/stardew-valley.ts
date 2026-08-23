import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import extract from 'extract-zip'

const execFileAsync = promisify(execFile)
const RELEASES_API = 'https://api.github.com/repos/qimidandapigu/dsh-xiaotangyuan-game/releases?per_page=50'
const DISTRIBUTION_MANIFEST_URL = 'https://raw.githubusercontent.com/qimidandapigu/dsh-xiaotangyuan-game/main/distribution/stardew-valley-v2.json'
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/'
const STARDEW_RELEASE_PREFIX = 'stardew-v'
const MINIMUM_ADAPTER_VERSION = '0.5.0'
const STARDEW_ASSET_PREFIX = 'dsh-xiaotangyuan-game-stardew-'
const MOD_FOLDER_NAME = 'StardewAgentMod'
const COMPANION_FOLDER_NAME = 'XiaoTangYuanCompanion'
const ADAPTER_UNIQUE_ID = 'qimidandapigu.StardewAgent'
const COMPANION_UNIQUE_ID = 'qimidandapigu.XiaoTangYuanCompanion'
const MANAGED_UNIQUE_IDS = new Set([
  ADAPTER_UNIQUE_ID,
  COMPANION_UNIQUE_ID,
  'Pathoschild.ContentPatcher',
  'mushymato.TrinketTinker',
])
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024
const MAX_COMPONENT_ARCHIVE_SIZE = 10 * 1024 * 1024

interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface GithubRelease {
  tag_name: string
  assets: ReleaseAsset[]
  draft?: boolean
}

export interface StardewDistributionManifest {
  schemaVersion: 2
  tag: string
  version: string
  archive: ReleaseAsset & { sha256: string }
  components: StardewComponentSpec[]
}

export interface StardewComponentSpec {
  uniqueId: 'Pathoschild.ContentPatcher' | 'mushymato.TrinketTinker'
  name: string
  version: string
  folderName: string
  archive: ReleaseAsset & { sha256: string }
}

interface InstallableStardewRelease {
  tagName: string
  archive: ReleaseAsset
  expectedSha256?: string
  checksumAsset?: ReleaseAsset
  components: StardewComponentSpec[]
}

interface ModManifest {
  Name?: string
  Version?: string
  UniqueID?: string
}

export interface StardewDetection {
  found: boolean
  platform: NodeJS.Platform
  gamePath?: string
  modsPath?: string
  smapiInstalled: boolean
  installedVersion?: string
  contentPatcherVersion?: string
  trinketTinkerVersion?: string
  companionPackVersion?: string
}

export interface StardewInstallResult {
  installed: true
  version: string
  gamePath: string
  modPath: string
  backupPath?: string
  components: string
}

interface InstalledMod {
  path: string
  version: string
}

interface PreparedPackage {
  name: string
  uniqueId: string
  version: string
  folderName: string
  sourcePath: string
  preserveConfig?: boolean
}

interface AppliedPackage {
  name: string
  uniqueId: string
  version: string
  destination: string
  action: 'installed' | 'updated' | 'kept'
  backupPath?: string
}

const FALLBACK_COMPONENTS: StardewComponentSpec[] = [
  {
    uniqueId: 'Pathoschild.ContentPatcher',
    name: 'Content Patcher',
    version: '2.9.1',
    folderName: 'ContentPatcher',
    archive: {
      name: 'ContentPatcher-2.9.1.zip',
      url: 'https://www.curseforge.com/api/v1/mods/309243/files/7759981/download',
      size: 389967,
      sha256: '22962ecbeda204d207f66f4dded727a2ce67134f7decdd249c1024bbc4576817',
    },
  },
  {
    uniqueId: 'mushymato.TrinketTinker',
    name: 'TrinketTinker',
    version: '1.9.0',
    folderName: 'TrinketTinker',
    archive: {
      name: 'TrinketTinker.1.9.0.zip',
      url: 'https://github.com/Mushymato/TrinketTinker/releases/download/1.9.0/TrinketTinker.1.9.0.zip',
      size: 164458,
      sha256: 'cb04fe77e43607c3914f68c781371a3c0442accad794ebb73de34666707dd4ef',
    },
  },
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function stripJsonComments(text: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!
    const next = text[index + 1]
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
      continue
    }
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      output += '\n'
      continue
    }
    if (current === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') output += '\n'
        index += 1
      }
      index += 1
      continue
    }
    output += current
  }
  return output
}

async function readManifest(path: string): Promise<ModManifest | undefined> {
  try {
    return JSON.parse(stripJsonComments(await readFile(path, 'utf8'))) as ModManifest
  } catch {
    return undefined
  }
}

async function findInstalledMod(modsPath: string, uniqueId: string): Promise<InstalledMod | undefined> {
  try {
    for (const entry of await readdir(modsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.includes('.backup-')) continue
      const path = join(modsPath, entry.name)
      const manifest = await readManifest(join(path, 'manifest.json'))
      if (manifest?.UniqueID === uniqueId && manifest.Version !== undefined) {
        return { path, version: manifest.Version }
      }
    }
  } catch {
    // The Mods directory may not exist yet.
  }
  return undefined
}

export function parseSteamLibraryPaths(vdf: string): string[] {
  const paths = new Set<string>()
  for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
    const value = match[1]?.replaceAll('\\\\', '\\').trim()
    if (value !== undefined && value !== '') paths.add(normalize(value))
  }
  return [...paths]
}

async function windowsSteamRoot(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await execFileAsync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, signal },
    )
    const match = result.stdout.match(/SteamPath\s+REG_SZ\s+(.+)$/im)
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

export async function steamRoots(signal?: AbortSignal): Promise<string[]> {
  const roots = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.trim() !== '') roots.add(normalize(value))
  }

  if (process.platform === 'win32') {
    add(await windowsSteamRoot(signal))
    add(process.env['ProgramFiles(x86)'] === undefined ? undefined : join(process.env['ProgramFiles(x86)'], 'Steam'))
    add(process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, 'Steam'))
  } else if (process.platform === 'darwin') {
    add(join(homedir(), 'Library', 'Application Support', 'Steam'))
  } else {
    add(join(homedir(), '.local', 'share', 'Steam'))
    add(join(homedir(), '.steam', 'steam'))
  }

  for (const root of [...roots]) {
    try {
      const vdf = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      for (const library of parseSteamLibraryPaths(vdf)) add(library)
    } catch {
      // A candidate Steam root may not exist or may predate libraryfolders.vdf.
    }
  }
  return [...roots]
}

export async function inspectStardewPath(gamePath: string): Promise<StardewDetection | undefined> {
  const resolved = resolve(gamePath)
  const gameMarkers = process.platform === 'win32'
    ? ['Stardew Valley.dll', 'StardewValley.exe']
    : process.platform === 'darwin'
      ? ['Contents/MacOS/StardewValley', 'Stardew Valley.dll']
      : ['Stardew Valley.dll', 'StardewValley']
  if (!(await Promise.all(gameMarkers.map(marker => exists(join(resolved, marker))))).some(Boolean)) return undefined

  const modsPath = join(resolved, 'Mods')
  const smapiMarkers = process.platform === 'win32'
    ? ['StardewModdingAPI.exe']
    : process.platform === 'darwin'
      ? ['StardewModdingAPI', 'Contents/MacOS/StardewModdingAPI']
      : ['StardewModdingAPI']
  const smapiInstalled = (await Promise.all(smapiMarkers.map(marker => exists(join(resolved, marker))))).some(Boolean)
  const [installed, contentPatcher, trinketTinker, companionPack] = await Promise.all([
    findInstalledMod(modsPath, ADAPTER_UNIQUE_ID),
    findInstalledMod(modsPath, 'Pathoschild.ContentPatcher'),
    findInstalledMod(modsPath, 'mushymato.TrinketTinker'),
    findInstalledMod(modsPath, COMPANION_UNIQUE_ID),
  ])

  return {
    found: true,
    platform: process.platform,
    gamePath: resolved,
    modsPath,
    smapiInstalled,
    ...(installed === undefined ? {} : { installedVersion: installed.version }),
    ...(contentPatcher === undefined ? {} : { contentPatcherVersion: contentPatcher.version }),
    ...(trinketTinker === undefined ? {} : { trinketTinkerVersion: trinketTinker.version }),
    ...(companionPack === undefined ? {} : { companionPackVersion: companionPack.version }),
  }
}

export async function detectStardew(gamePath?: string, signal?: AbortSignal): Promise<StardewDetection> {
  if (gamePath !== undefined && gamePath.trim() !== '') {
    const explicit = await inspectStardewPath(gamePath.trim())
    if (explicit !== undefined) return explicit
    return { found: false, platform: process.platform, smapiInstalled: false }
  }

  for (const root of await steamRoots(signal)) {
    const candidate = join(root, 'steamapps', 'common', 'Stardew Valley')
    const detection = await inspectStardewPath(candidate)
    if (detection !== undefined) return detection
  }
  return { found: false, platform: process.platform, smapiInstalled: false }
}

async function fetchChecked(
  url: string,
  signal: AbortSignal,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal,
        headers: {
          Accept: accept,
          'User-Agent': 'dsh-xiaotangyuan-game',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (response.ok) return response
      if (response.status < 500 || attempt === 3) {
        throw new Error(`download failed (${response.status}) for ${url}`)
      }
      lastError = new Error(`download failed (${response.status}) for ${url}`)
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
      if (attempt === 3) throw error
    }
    await delay(attempt * 500, undefined, { signal })
  }
  throw lastError instanceof Error ? lastError : new Error(`download failed for ${url}`)
}

export function selectStardewRelease(value: unknown): GithubRelease {
  if (!Array.isArray(value)) throw new Error('GitHub returned an invalid release list')
  const release = value.find((candidate): candidate is GithubRelease => {
    if (typeof candidate !== 'object' || candidate === null) return false
    const record = candidate as Partial<GithubRelease>
    return record.draft !== true
      && typeof record.tag_name === 'string'
      && record.tag_name.startsWith(STARDEW_RELEASE_PREFIX)
      && Array.isArray(record.assets)
  })
  if (release === undefined) throw new Error('no Stardew Valley release was found in the XiaoTangYuan repository')
  return release
}

function numericVersion(value: string): readonly number[] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isCompatibleStardewRelease(tag: string): boolean {
  if (!tag.startsWith(STARDEW_RELEASE_PREFIX)) return false
  const actual = numericVersion(tag.slice(STARDEW_RELEASE_PREFIX.length))
  const minimum = numericVersion(MINIMUM_ADAPTER_VERSION)
  if (actual === undefined || minimum === undefined) return false
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true
    if (actual[index]! < minimum[index]!) return false
  }
  return true
}

function parseComponentSpec(value: unknown): StardewComponentSpec {
  if (typeof value !== 'object' || value === null) throw new Error('星露谷发布清单包含无效的组件')
  const component = value as Partial<StardewComponentSpec>
  const expected = FALLBACK_COMPONENTS.find(candidate => candidate.uniqueId === component.uniqueId)
  if (expected === undefined) throw new Error('星露谷发布清单包含未知组件')
  if (component.name !== expected.name || component.folderName !== expected.folderName) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 的名称或目录无效`)
  }
  if (typeof component.version !== 'string' || numericVersion(component.version) === undefined) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 的版本无效`)
  }
  if ((compareStableVersions(component.version, expected.version) ?? -1) < 0) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 低于最低版本 ${expected.version}`)
  }
  if (typeof component.archive !== 'object' || component.archive === null) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 缺少安装包`)
  }
  const archive = component.archive as Partial<StardewComponentSpec['archive']>
  if (typeof archive.name !== 'string' || !archive.name.endsWith('.zip')) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 的安装包名称无效`)
  }
  const officialUrl = expected.uniqueId === 'Pathoschild.ContentPatcher'
    ? /^https:\/\/www\.curseforge\.com\/api\/v1\/mods\/309243\/files\/\d+\/download$/.test(archive.url ?? '')
    : archive.url === `https://github.com/Mushymato/TrinketTinker/releases/download/${component.version}/TrinketTinker.${component.version}.zip`
  if (!officialUrl) throw new Error(`星露谷组件 ${expected.uniqueId} 包含非官方安装地址`)
  if (typeof archive.size !== 'number'
    || !Number.isSafeInteger(archive.size)
    || archive.size <= 0
    || archive.size > MAX_COMPONENT_ARCHIVE_SIZE) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 的安装包大小无效`)
  }
  if (typeof archive.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(archive.sha256)) {
    throw new Error(`星露谷组件 ${expected.uniqueId} 的 SHA-256 无效`)
  }
  return {
    uniqueId: expected.uniqueId,
    name: expected.name,
    version: component.version,
    folderName: expected.folderName,
    archive: {
      name: archive.name,
      url: archive.url!,
      size: archive.size,
      sha256: archive.sha256.toLowerCase(),
    },
  }
}

export function parseStardewDistributionManifest(value: unknown): StardewDistributionManifest {
  if (typeof value !== 'object' || value === null) throw new Error('星露谷发布清单不是对象')
  const record = value as Partial<StardewDistributionManifest>
  if (record.schemaVersion !== 2) throw new Error('星露谷发布清单版本不受支持')
  if (typeof record.tag !== 'string' || !isCompatibleStardewRelease(record.tag)) {
    throw new Error('星露谷发布清单包含无效或不兼容的版本标签')
  }
  const version = record.tag.slice(STARDEW_RELEASE_PREFIX.length)
  if (record.version !== version) throw new Error('星露谷发布清单的版本与标签不一致')
  if (typeof record.archive !== 'object' || record.archive === null) {
    throw new Error('星露谷发布清单缺少安装包')
  }
  const archive = record.archive as Partial<StardewDistributionManifest['archive']>
  if (typeof archive.name !== 'string'
    || !archive.name.startsWith(STARDEW_ASSET_PREFIX)
    || !archive.name.endsWith('.zip')) {
    throw new Error('星露谷发布清单包含无效的安装包名称')
  }
  const expectedUrl = `${RELEASE_DOWNLOAD_PREFIX}${record.tag}/${archive.name}`
  if (archive.url !== expectedUrl) throw new Error('星露谷发布清单包含非官方安装地址')
  if (typeof archive.size !== 'number'
    || !Number.isSafeInteger(archive.size)
    || archive.size <= 0
    || archive.size > MAX_ARCHIVE_SIZE) {
    throw new Error('星露谷发布清单包含无效的安装包大小')
  }
  if (typeof archive.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(archive.sha256)) {
    throw new Error('星露谷发布清单包含无效的 SHA-256')
  }
  if (!Array.isArray(record.components)) throw new Error('星露谷发布清单缺少第三方组件')
  const components = record.components.map(parseComponentSpec)
  if (new Set(components.map(component => component.uniqueId)).size !== components.length) {
    throw new Error('星露谷发布清单包含重复组件')
  }
  for (const expected of FALLBACK_COMPONENTS) {
    if (!components.some(component => component.uniqueId === expected.uniqueId)) {
      throw new Error(`星露谷发布清单缺少组件 ${expected.name}`)
    }
  }
  return {
    schemaVersion: 2,
    tag: record.tag,
    version,
    archive: {
      name: archive.name,
      url: archive.url,
      size: archive.size,
      sha256: archive.sha256.toLowerCase(),
    },
    components,
  }
}

async function releaseFromManifest(signal: AbortSignal): Promise<InstallableStardewRelease> {
  const value: unknown = await (await fetchChecked(DISTRIBUTION_MANIFEST_URL, signal, 'application/json')).json()
  const manifest = parseStardewDistributionManifest(value)
  return {
    tagName: manifest.tag,
    archive: manifest.archive,
    expectedSha256: manifest.archive.sha256,
    components: manifest.components,
  }
}

async function releaseFromGithubApi(signal: AbortSignal): Promise<InstallableStardewRelease> {
  const value: unknown = await (await fetchChecked(RELEASES_API, signal)).json()
  const release = selectStardewRelease(value)
  if (!isCompatibleStardewRelease(release.tag_name)) {
    throw new Error(`最新星露谷适配器 ${release.tag_name} 低于当前插件要求的 ${STARDEW_RELEASE_PREFIX}${MINIMUM_ADAPTER_VERSION}，已拒绝安装旧演示版`)
  }
  const archive = release.assets.find(asset => asset.name.startsWith(STARDEW_ASSET_PREFIX) && asset.name.endsWith('.zip'))
  const checksumAsset = release.assets.find(asset => asset.name === 'SHA256SUMS.txt')
  if (archive === undefined || checksumAsset === undefined) {
    throw new Error('latest XiaoTangYuan Stardew release is missing its zip or SHA256SUMS.txt')
  }
  return { tagName: release.tag_name, archive, checksumAsset, components: FALLBACK_COMPONENTS }
}

async function latestRelease(signal: AbortSignal): Promise<InstallableStardewRelease> {
  try {
    return await releaseFromManifest(signal)
  } catch (manifestError) {
    if (signal.aborted) throw manifestError
    try {
      return await releaseFromGithubApi(signal)
    } catch (apiError) {
      const manifestMessage = manifestError instanceof Error ? manifestError.message : String(manifestError)
      const apiMessage = apiError instanceof Error ? apiError.message : String(apiError)
      throw new Error(`无法读取星露谷安装源。静态清单：${manifestMessage}；GitHub API：${apiMessage}`)
    }
  }
}

function safeChild(parent: string, child: string): void {
  const pathFromParent = relative(resolve(parent), resolve(child))
  if (pathFromParent === '' || pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new Error(`refusing unsafe MOD destination: ${child}`)
  }
}

function checksumLine(text: string, assetName: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (match?.[2] === assetName) return match[1]?.toLowerCase()
  }
  return undefined
}

export async function preserveStardewConfig(backupPath: string, destination: string): Promise<boolean> {
  const previousConfig = join(backupPath, 'config.json')
  if (!(await exists(previousConfig))) return false
  await cp(previousConfig, join(destination, 'config.json'), { force: true })
  return true
}

async function availableBackupPath(backupRoot: string, name: string): Promise<string> {
  const initial = join(backupRoot, name)
  if (!(await exists(initial))) return initial
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = join(backupRoot, `${name}-${index}`)
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`无法为 ${name} 创建唯一备份目录`)
}

export async function migrateLegacyStardewBackups(
  modsPath: string,
  backupRoot: string,
): Promise<string[]> {
  const gameRoot = resolve(modsPath, '..')
  safeChild(gameRoot, backupRoot)
  const pathFromMods = relative(resolve(modsPath), resolve(backupRoot))
  if (pathFromMods === '' || (!pathFromMods.startsWith('..') && !isAbsolute(pathFromMods))) {
    throw new Error('星露谷备份目录不能位于 Mods 内')
  }
  if (!(await exists(modsPath))) return []

  await mkdir(backupRoot, { recursive: true })
  const moved: string[] = []
  for (const entry of await readdir(modsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('.backup-')) continue
    const source = join(modsPath, entry.name)
    const manifest = await readManifest(join(source, 'manifest.json'))
    if (manifest?.UniqueID === undefined || !MANAGED_UNIQUE_IDS.has(manifest.UniqueID)) continue
    safeChild(modsPath, source)
    const destination = await availableBackupPath(backupRoot, entry.name)
    safeChild(backupRoot, destination)
    await rename(source, destination)
    moved.push(destination)
  }
  return moved
}

export function compareStableVersions(left: string, right: string): number | undefined {
  const leftParts = numericVersion(left)
  const rightParts = numericVersion(right)
  if (leftParts === undefined || rightParts === undefined) return undefined
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1
    if (leftParts[index]! < rightParts[index]!) return -1
  }
  return 0
}

async function downloadVerifiedArchive(
  asset: ReleaseAsset,
  expectedSha256: string,
  maximumSize: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (asset.size > maximumSize) throw new Error(`refusing oversized archive ${asset.name}`)
  const response = await fetchChecked(asset.url, signal, 'application/octet-stream')
  const archive = new Uint8Array(await response.arrayBuffer())
  if (archive.byteLength > maximumSize) throw new Error(`downloaded archive ${asset.name} exceeds its size limit`)
  if (archive.byteLength !== asset.size) {
    throw new Error(`archive size mismatch for ${asset.name}: expected ${asset.size}, received ${archive.byteLength}`)
  }
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`archive checksum mismatch for ${asset.name}: expected ${expectedSha256}, received ${actual}`)
  }
  return archive
}

async function prepareArchivePackages(
  tempRoot: string,
  key: string,
  asset: ReleaseAsset,
  expectedSha256: string,
  maximumSize: number,
  packages: Array<Omit<PreparedPackage, 'sourcePath' | 'version'> & { version?: string }>,
  signal: AbortSignal,
): Promise<PreparedPackage[]> {
  const archive = await downloadVerifiedArchive(asset, expectedSha256, maximumSize, signal)
  const archivePath = join(tempRoot, `${key}-${basename(asset.name)}`)
  await writeFile(archivePath, archive)
  const extractedPath = join(tempRoot, `extracted-${key}`)
  await mkdir(extractedPath)
  await extract(archivePath, { dir: extractedPath })

  const prepared: PreparedPackage[] = []
  for (const expected of packages) {
    const sourcePath = join(extractedPath, expected.folderName)
    const manifest = await readManifest(join(sourcePath, 'manifest.json'))
    if (manifest?.UniqueID !== expected.uniqueId || manifest.Version === undefined) {
      throw new Error(`${asset.name} does not contain a valid ${expected.name} package`)
    }
    if (expected.version !== undefined && compareStableVersions(manifest.Version, expected.version) !== 0) {
      throw new Error(`${expected.name} version mismatch: expected ${expected.version}, received ${manifest.Version}`)
    }
    prepared.push({ ...expected, version: manifest.Version, sourcePath })
  }
  return prepared
}

async function applyPreparedPackage(
  modsPath: string,
  backupRoot: string,
  prepared: PreparedPackage,
  timestamp: string,
): Promise<AppliedPackage> {
  const installed = await findInstalledMod(modsPath, prepared.uniqueId)
  const comparison = installed === undefined ? undefined : compareStableVersions(installed.version, prepared.version)
  if (installed !== undefined && comparison !== undefined && comparison >= 0) {
    return {
      name: prepared.name,
      uniqueId: prepared.uniqueId,
      version: installed.version,
      destination: installed.path,
      action: 'kept',
    }
  }

  const destination = installed?.path ?? join(modsPath, prepared.folderName)
  safeChild(modsPath, destination)
  let backupPath: string | undefined
  if (await exists(destination)) {
    backupPath = await availableBackupPath(backupRoot, `${basename(destination)}.backup-${timestamp}`)
    safeChild(backupRoot, backupPath)
    await rename(destination, backupPath)
  }

  try {
    await cp(prepared.sourcePath, destination, { recursive: true, errorOnExist: true })
    if (prepared.preserveConfig === true && backupPath !== undefined) {
      await preserveStardewConfig(backupPath, destination)
    }
    const installedManifest = await readManifest(join(destination, 'manifest.json'))
    if (installedManifest?.UniqueID !== prepared.uniqueId || installedManifest.Version !== prepared.version) {
      throw new Error(`${prepared.name} failed manifest verification after installation`)
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    if (backupPath !== undefined && await exists(backupPath)) await rename(backupPath, destination)
    throw error
  }

  return {
    name: prepared.name,
    uniqueId: prepared.uniqueId,
    version: prepared.version,
    destination,
    action: installed === undefined ? 'installed' : 'updated',
    ...(backupPath === undefined ? {} : { backupPath }),
  }
}

async function rollbackAppliedPackages(applied: AppliedPackage[]): Promise<void> {
  for (const item of [...applied].reverse()) {
    if (item.action === 'kept') continue
    await rm(item.destination, { recursive: true, force: true })
    if (item.backupPath !== undefined && await exists(item.backupPath)) {
      await rename(item.backupPath, item.destination)
    }
  }
}

export async function installStardewMod(
  gamePath: string | undefined,
  signal: AbortSignal,
): Promise<StardewInstallResult> {
  const detection = await detectStardew(gamePath, signal)
  if (!detection.found || detection.gamePath === undefined || detection.modsPath === undefined) {
    throw new Error('Stardew Valley was not found; provide its installation directory as gamePath')
  }
  if (!detection.smapiInstalled) {
    throw new Error(`SMAPI was not found in ${detection.gamePath}; install SMAPI before installing this MOD`)
  }

  const release = await latestRelease(signal)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-xiaotangyuan-game-'))
  try {
    let expected = release.expectedSha256
    if (expected === undefined) {
      if (release.checksumAsset === undefined) throw new Error('星露谷发布信息缺少 SHA-256 校验值')
      const checksumText = await (await fetchChecked(release.checksumAsset.url, signal, 'application/octet-stream')).text()
      expected = checksumLine(checksumText, release.archive.name)
      if (expected === undefined) throw new Error(`SHA256SUMS.txt has no entry for ${release.archive.name}`)
    }
    const firstParty = await prepareArchivePackages(
      tempRoot,
      'xiaotangyuan',
      release.archive,
      expected,
      MAX_ARCHIVE_SIZE,
      [
        {
          name: 'XiaoTangYuan Companion Pack',
          uniqueId: COMPANION_UNIQUE_ID,
          folderName: COMPANION_FOLDER_NAME,
          version: release.tagName.slice(STARDEW_RELEASE_PREFIX.length),
        },
        {
          name: 'Stardew Agent Mod',
          uniqueId: ADAPTER_UNIQUE_ID,
          folderName: MOD_FOLDER_NAME,
          version: release.tagName.slice(STARDEW_RELEASE_PREFIX.length),
          preserveConfig: true,
        },
      ],
      signal,
    )
    const dependencies: PreparedPackage[] = []
    for (const [index, component] of release.components.entries()) {
      dependencies.push(...await prepareArchivePackages(
        tempRoot,
        `component-${index}`,
        component.archive,
        component.archive.sha256,
        MAX_COMPONENT_ARCHIVE_SIZE,
        [{
          name: component.name,
          uniqueId: component.uniqueId,
          folderName: component.folderName,
          version: component.version,
        }],
        signal,
      ))
    }

    await mkdir(detection.modsPath, { recursive: true })
    const backupRoot = join(detection.gamePath, '.xiaotangyuan-backups')
    await mkdir(backupRoot, { recursive: true })
    const migratedBackups = await migrateLegacyStardewBackups(detection.modsPath, backupRoot)
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    const applied: AppliedPackage[] = []
    try {
      for (const prepared of [...dependencies, ...firstParty]) {
        applied.push(await applyPreparedPackage(detection.modsPath, backupRoot, prepared, timestamp))
      }
    } catch (error) {
      await rollbackAppliedPackages(applied)
      throw error
    }

    const adapter = applied.find(item => item.uniqueId === ADAPTER_UNIQUE_ID)!
    return {
      installed: true,
      version: adapter.version,
      gamePath: detection.gamePath,
      modPath: adapter.destination,
      ...(adapter.backupPath === undefined ? {} : { backupPath: adapter.backupPath }),
      components: [
        ...applied.map(item => `${item.name} ${item.version} (${item.action})`),
        ...(migratedBackups.length === 0 ? [] : [`迁移旧备份 ${migratedBackups.length} 个`]),
      ].join(', '),
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
