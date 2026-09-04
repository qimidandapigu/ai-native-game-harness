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
  reconcileBundledStardewInstallation,
  selectStardewRelease,
  stripJsonComments,
} from '../src/installation/stardew-valley.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function writeMod(
  modsPath: string,
  folderName: string,
  uniqueId: string,
  version: string,
  files: Record<string, string> = {},
): Promise<string> {
  const target = join(modsPath, folderName)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'manifest.json'), JSON.stringify({ UniqueID: uniqueId, Version: version }))
  await Promise.all(Object.entries(files).map(async ([name, content]) => {
    await writeFile(join(target, name), content)
  }))
  return target
}

async function stardewFixture(smapiInstalled = true): Promise<{
  root: string
  mods: string
  source: { version: string, adapterPath: string, companionPath: string }
}> {
  const root = await mkdtemp(join(tmpdir(), 'stardew-reconcile-test-'))
  temporaryPaths.push(root)
  await writeFile(join(root, 'Stardew Valley.dll'), '')
  if (smapiInstalled) {
    await writeFile(join(root, process.platform === 'win32' ? 'StardewModdingAPI.exe' : 'StardewModdingAPI'), '')
  }
  const mods = join(root, 'Mods')
  const bundled = join(root, 'bundled')
  const adapterPath = await writeMod(
    bundled,
    'StardewAgentMod',
    'qimidandapigu.StardewAgent',
    '0.8.0',
    { 'StardewAgentMod.dll': 'new-adapter' },
  )
  const companionPath = await writeMod(
    bundled,
    'XiaoTangYuanCompanion',
    'qimidandapigu.XiaoTangYuanCompanion',
    '0.8.0',
    { 'content.json': '{"Format":"2.8.0"}' },
  )
  return { root, mods, source: { version: '0.8.0', adapterPath, companionPath } }
}

async function installCurrentDependencies(mods: string): Promise<void> {
  await writeMod(mods, 'ContentPatcher', 'Pathoschild.ContentPatcher', '2.9.1')
  await writeMod(mods, 'TrinketTinker', 'mushymato.TrinketTinker', '1.9.0')
}

describe('inspectStardewPath', () => {
  it.skipIf(process.platform !== 'darwin')('uses the SMAPI Mods directory inside a macOS app bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-macos-layout-test-'))
    temporaryPaths.push(root)
    const runtimeRoot = join(root, 'Contents', 'MacOS')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(join(runtimeRoot, 'StardewValley'), '')
    await writeFile(join(runtimeRoot, 'StardewModdingAPI'), '')
    await writeMod(
      join(runtimeRoot, 'Mods'),
      'StardewAgentMod',
      'qimidandapigu.StardewAgent',
      '0.8.0',
    )

    const detection = await inspectStardewPath(root)

    expect(detection).toMatchObject({
      found: true,
      gamePath: root,
      modsPath: join(runtimeRoot, 'Mods'),
      smapiInstalled: true,
      installedVersion: '0.8.0',
    })
  })
})

describe('reconcileBundledStardewInstallation', () => {
  it('installs bundled first-party MODs while keeping current dependencies', async () => {
    const fixture = await stardewFixture()
    await installCurrentDependencies(fixture.mods)

    const result = await reconcileBundledStardewInstallation(
      fixture.root,
      fixture.source,
      AbortSignal.timeout(5_000),
    )

    expect(result.status).toBe('changed')
    expect(result.packages.map(item => [item.uniqueId, item.action])).toEqual([
      ['Pathoschild.ContentPatcher', 'kept'],
      ['mushymato.TrinketTinker', 'kept'],
      ['qimidandapigu.XiaoTangYuanCompanion', 'installed'],
      ['qimidandapigu.StardewAgent', 'installed'],
    ])
    await expect(readFile(join(fixture.mods, 'StardewAgentMod', 'StardewAgentMod.dll'), 'utf8'))
      .resolves.toBe('new-adapter')
  })

  it('updates old first-party MODs transactionally and preserves adapter config', async () => {
    const fixture = await stardewFixture()
    await installCurrentDependencies(fixture.mods)
    await writeMod(
      fixture.mods,
      'StardewAgentMod',
      'qimidandapigu.StardewAgent',
      '0.5.0',
      { 'StardewAgentMod.dll': 'old-adapter', 'config.json': '{"TextChatKey":"Y"}' },
    )
    await writeMod(
      fixture.mods,
      'XiaoTangYuanCompanion',
      'qimidandapigu.XiaoTangYuanCompanion',
      '0.5.0',
      { 'content.json': '{"old":true}' },
    )

    const result = await reconcileBundledStardewInstallation(
      fixture.root,
      fixture.source,
      AbortSignal.timeout(5_000),
    )

    expect(result.status).toBe('changed')
    expect(result.packages.filter(item => item.action === 'updated')).toHaveLength(2)
    await expect(readFile(join(fixture.mods, 'StardewAgentMod', 'config.json'), 'utf8'))
      .resolves.toBe('{"TextChatKey":"Y"}')
    await expect(readFile(join(fixture.mods, 'StardewAgentMod', 'StardewAgentMod.dll'), 'utf8'))
      .resolves.toBe('new-adapter')
  })

  it.skipIf(process.platform !== 'darwin')('updates bundled MODs in the macOS app layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stardew-macos-reconcile-test-'))
    temporaryPaths.push(root)
    const runtimeRoot = join(root, 'Contents', 'MacOS')
    const mods = join(runtimeRoot, 'Mods')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(join(runtimeRoot, 'StardewValley'), '')
    await writeFile(join(runtimeRoot, 'StardewModdingAPI'), '')
    await installCurrentDependencies(mods)
    await writeMod(
      mods,
      'StardewAgentMod',
      'qimidandapigu.StardewAgent',
      '0.5.1',
      { 'StardewAgentMod.dll': 'old-adapter', 'config.json': '{"TextChatKey":"Y"}' },
    )
    await writeMod(
      mods,
      'XiaoTangYuanCompanion',
      'qimidandapigu.XiaoTangYuanCompanion',
      '0.5.0',
      { 'content.json': '{"old":true}' },
    )
    const bundled = join(root, 'bundled')
    const adapterPath = await writeMod(
      bundled,
      'StardewAgentMod',
      'qimidandapigu.StardewAgent',
      '0.8.0',
      { 'StardewAgentMod.dll': 'new-adapter' },
    )
    const companionPath = await writeMod(
      bundled,
      'XiaoTangYuanCompanion',
      'qimidandapigu.XiaoTangYuanCompanion',
      '0.8.0',
      { 'content.json': '{"Format":"2.8.0"}' },
    )

    const result = await reconcileBundledStardewInstallation(
      root,
      { version: '0.8.0', adapterPath, companionPath },
      AbortSignal.timeout(5_000),
    )

    expect(result.status).toBe('changed')
    expect(result.backupRoot).toBe(join(runtimeRoot, '.xiaotangyuan-backups'))
    await expect(readFile(join(mods, 'StardewAgentMod', 'StardewAgentMod.dll'), 'utf8'))
      .resolves.toBe('new-adapter')
    await expect(readFile(join(mods, 'StardewAgentMod', 'config.json'), 'utf8'))
      .resolves.toBe('{"TextChatKey":"Y"}')
  })

  it('does not downgrade newer MODs or touch an already current installation', async () => {
    const fixture = await stardewFixture()
    await installCurrentDependencies(fixture.mods)
    await writeMod(
      fixture.mods,
      'StardewAgentMod',
      'qimidandapigu.StardewAgent',
      '0.9.0',
      { 'StardewAgentMod.dll': 'newer-adapter' },
    )
    await writeMod(
      fixture.mods,
      'XiaoTangYuanCompanion',
      'qimidandapigu.XiaoTangYuanCompanion',
      '0.9.0',
    )

    const result = await reconcileBundledStardewInstallation(
      fixture.root,
      fixture.source,
      AbortSignal.timeout(5_000),
    )

    expect(result.status).toBe('current')
    expect(result.packages.every(item => item.action === 'kept')).toBe(true)
    expect(result.backupRoot).toBeUndefined()
    await expect(readFile(join(fixture.mods, 'StardewAgentMod', 'StardewAgentMod.dll'), 'utf8'))
      .resolves.toBe('newer-adapter')
  })

  it('reports a missing SMAPI prerequisite without modifying Mods', async () => {
    const fixture = await stardewFixture(false)

    const result = await reconcileBundledStardewInstallation(
      fixture.root,
      fixture.source,
      AbortSignal.timeout(5_000),
    )

    expect(result.status).toBe('smapi-missing')
    await expect(readFile(join(fixture.mods, 'StardewAgentMod', 'manifest.json'), 'utf8')).rejects.toThrow()
  })
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
          url: 'https://mediafilez.forgecdn.net/files/7759/981/Content%20Patcher%202.9.1%202.9.1.zip',
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
          url: 'https://api.github.com/repos/Mushymato/TrinketTinker/releases/assets/515207334',
          size: 164458,
          sha256: 'cb04fe77e43607c3914f68c781371a3c0442accad794ebb73de34666707dd4ef',
        },
      },
    ],
  }

  it('accepts the official static release manifest', () => {
    expect(parseStardewDistributionManifest(validManifest)).toEqual(validManifest)
  })

  it('normalizes the legacy CurseForge API route to the fixed official CDN asset', () => {
    const legacy = structuredClone(validManifest)
    legacy.components[0]!.archive.url = 'https://www.curseforge.com/api/v1/mods/309243/files/7759981/download'
    expect(parseStardewDistributionManifest(legacy).components[0]!.archive.url)
      .toBe('https://mediafilez.forgecdn.net/files/7759/981/Content%20Patcher%202.9.1%202.9.1.zip')
  })

  it('normalizes the legacy GitHub browser route to the official asset API', () => {
    const legacy = structuredClone(validManifest)
    legacy.components[1]!.archive.url = 'https://github.com/Mushymato/TrinketTinker/releases/download/1.9.0/TrinketTinker.1.9.0.zip'
    expect(parseStardewDistributionManifest(legacy).components[1]!.archive.url)
      .toBe('https://api.github.com/repos/Mushymato/TrinketTinker/releases/assets/515207334')
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
