import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectStardewPath,
  isCompatibleStardewRelease,
  compareStableVersions,
  migrateLegacyStardewBackups,
  parseStardewDistributionManifest,
  parseSteamLibraryPaths,
  preserveStardewConfig,
  selectStardewRelease,
  stripJsonComments,
} from '../src/installation/stardew-valley.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('preserveStardewConfig', () => {
  it('restores the previous config over packaged defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-config-test-'))
    temporaryPaths.push(root)
    const backup = join(root, 'backup')
    const destination = join(root, 'destination')
    await mkdir(backup)
    await mkdir(destination)
    await writeFile(join(backup, 'config.json'), '{"TextChatKey":"T"}')
    await writeFile(join(destination, 'config.json'), '{"TextChatKey":"Y"}')

    await expect(preserveStardewConfig(backup, destination)).resolves.toBe(true)
    await expect(readFile(join(destination, 'config.json'), 'utf8')).resolves.toBe('{"TextChatKey":"T"}')
  })

  it('leaves the destination unchanged when no previous config exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-config-test-'))
    temporaryPaths.push(root)
    const backup = join(root, 'backup')
    const destination = join(root, 'destination')
    await mkdir(backup)
    await mkdir(destination)
    await writeFile(join(destination, 'config.json'), '{"TextChatKey":"Y"}')

    await expect(preserveStardewConfig(backup, destination)).resolves.toBe(false)
    await expect(readFile(join(destination, 'config.json'), 'utf8')).resolves.toBe('{"TextChatKey":"Y"}')
  })
})

describe('parseStardewDistributionManifest', () => {
  const validManifest = {
    schemaVersion: 2,
    tag: 'stardew-v0.5.0',
    version: '0.5.0',
    archive: {
      name: 'dsh-xiaotangyuan-game-stardew-0.5.0.zip',
      url: 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/stardew-v0.5.0/dsh-xiaotangyuan-game-stardew-0.5.0.zip',
      size: 40000,
      sha256: '0a1b712f4ca0498e79d742cfe6c0c3fea9d49a64300505e1590044da7a233a3b',
    },
    components: [
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
    ],
  }

  it('accepts the official static release manifest', () => {
    expect(parseStardewDistributionManifest(validManifest)).toEqual(validManifest)
  })

  it('rejects a mismatched version or foreign archive URL', () => {
    expect(() => parseStardewDistributionManifest({ ...validManifest, version: '0.4.0' })).toThrow('版本与标签不一致')
    expect(() => parseStardewDistributionManifest({
      ...validManifest,
      archive: { ...validManifest.archive, url: 'https://example.test/mod.zip' },
    })).toThrow('非官方安装地址')
  })

  it('rejects an invalid checksum', () => {
    expect(() => parseStardewDistributionManifest({
      ...validManifest,
      archive: { ...validManifest.archive, sha256: 'not-a-checksum' },
    })).toThrow('无效的 SHA-256')
  })
})

describe('migrateLegacyStardewBackups', () => {
  it('moves only XiaoTangYuan-managed backup mods outside Mods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-backup-migration-test-'))
    temporaryPaths.push(root)
    const mods = join(root, 'Mods')
    const backupRoot = join(root, '.xiaotangyuan-backups')
    const managed = join(mods, 'StardewAgentMod.backup-old')
    const unrelated = join(mods, 'OtherMod.backup-old')
    await mkdir(managed, { recursive: true })
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(managed, 'manifest.json'), JSON.stringify({
      UniqueID: 'qimidandapigu.StardewAgent',
      Version: '0.4.0',
    }))
    await writeFile(join(unrelated, 'manifest.json'), JSON.stringify({
      UniqueID: 'example.OtherMod',
      Version: '1.0.0',
    }))

    const moved = await migrateLegacyStardewBackups(mods, backupRoot)

    expect(moved).toHaveLength(1)
    await expect(readFile(join(moved[0]!, 'manifest.json'), 'utf8')).resolves.toContain('qimidandapigu.StardewAgent')
    await expect(readFile(join(unrelated, 'manifest.json'), 'utf8')).resolves.toContain('example.OtherMod')
    await expect(readFile(join(managed, 'manifest.json'), 'utf8')).rejects.toThrow()
  })

  it('rejects a backup root inside Mods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-backup-migration-test-'))
    temporaryPaths.push(root)
    const mods = join(root, 'Mods')
    await mkdir(mods)
    await expect(migrateLegacyStardewBackups(mods, join(mods, 'Backups')))
      .rejects.toThrow('不能位于 Mods 内')
  })
})

describe('version and JSONC helpers', () => {
  it('compares stable semantic versions', () => {
    expect(compareStableVersions('2.9.1', '2.9.0')).toBe(1)
    expect(compareStableVersions('1.9.0', '1.9.0')).toBe(0)
    expect(compareStableVersions('0.5.0', '1.0.0')).toBe(-1)
    expect(compareStableVersions('latest', '1.0.0')).toBeUndefined()
  })

  it('removes manifest comments without damaging URL strings', () => {
    const value = JSON.parse(stripJsonComments(`{
      /* generated manifest */
      "UniqueID": "mushymato.TrinketTinker", // framework
      "Update": "https://github.com/Mushymato/TrinketTinker"
    }`)) as { UniqueID: string, Update: string }
    expect(value).toEqual({
      UniqueID: 'mushymato.TrinketTinker',
      Update: 'https://github.com/Mushymato/TrinketTinker',
    })
  })
})

describe('parseSteamLibraryPaths', () => {
  it('reads and deduplicates Steam library paths', () => {
    const paths = parseSteamLibraryPaths(`
      "1" { "path" "D:\\\\SteamLibrary" }
      "2" { "path" "E:\\\\Games" }
      "3" { "path" "D:\\\\SteamLibrary" }
    `)
    expect(paths).toEqual(['D:\\SteamLibrary', 'E:\\Games'])
  })
})

describe('inspectStardewPath', () => {
  it('reports SMAPI and the installed MOD version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-detect-test-'))
    temporaryPaths.push(root)
    await writeFile(join(root, 'Stardew Valley.dll'), '')
    await writeFile(join(root, process.platform === 'win32' ? 'StardewModdingAPI.exe' : 'StardewModdingAPI'), '')
    const modPath = join(root, 'Mods', 'StardewAgentMod')
    await mkdir(modPath, { recursive: true })
    await writeFile(join(modPath, 'manifest.json'), JSON.stringify({
      UniqueID: 'qimidandapigu.StardewAgent',
      Version: '0.1.0',
    }))

    await expect(inspectStardewPath(root)).resolves.toMatchObject({
      found: true,
      smapiInstalled: true,
      installedVersion: '0.1.0',
    })
  })

  it('rejects a directory without a game marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-detect-test-'))
    temporaryPaths.push(root)
    await expect(inspectStardewPath(root)).resolves.toBeUndefined()
  })
})

describe('selectStardewRelease', () => {
  it('selects the newest Stardew release and skips plugin releases', () => {
    expect(selectStardewRelease([
      { tag_name: 'plugin-v0.3.0', draft: false, assets: [] },
      { tag_name: 'stardew-v0.3.0', draft: false, assets: [{ name: 'mod.zip', url: 'https://example.test', size: 1 }] },
      { tag_name: 'stardew-v0.2.0', draft: false, assets: [{ name: 'mod.zip', url: 'https://example.test', size: 1 }] },
      { tag_name: 'stardew-v0.1.0', draft: false, assets: [] },
    ]).tag_name).toBe('stardew-v0.3.0')
  })

  it('rejects a list with no published Stardew release', () => {
    expect(() => selectStardewRelease([
      { tag_name: 'stardew-v0.2.0', draft: true, assets: [] },
      { tag_name: 'plugin-v0.3.0', draft: false, assets: [] },
    ])).toThrow('no Stardew Valley release')
  })

  it('rejects releases older than the first Harness-owned voice adapter', () => {
    expect(isCompatibleStardewRelease('stardew-v0.2.0')).toBe(false)
    expect(isCompatibleStardewRelease('stardew-v0.3.0')).toBe(false)
    expect(isCompatibleStardewRelease('stardew-v0.5.0')).toBe(true)
    expect(isCompatibleStardewRelease('stardew-v1.0.0')).toBe(true)
  })
})
