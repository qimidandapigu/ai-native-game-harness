import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyOniPackage,
  inspectOniPath,
  parseOniDistributionManifest,
} from '../src/installation.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string, game: string, mods: string, packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oni-test-'))
  roots.push(root)
  const game = join(root, 'OxygenNotIncluded')
  const mods = join(root, 'Documents', 'Klei', 'OxygenNotIncluded', 'mods')
  const packageRoot = join(root, 'package')
  await mkdir(join(game, 'OxygenNotIncluded_Data', 'Managed'), { recursive: true })
  await writeFile(join(game, 'OxygenNotIncluded_Data', 'Managed', 'Assembly-CSharp.dll'), 'game marker')
  await mkdir(packageRoot)
  await writeFile(join(packageRoot, 'DoubaoAI.ONI.dll'), 'new bridge')
  await writeFile(join(packageRoot, 'mod.yaml'), 'supportedContent: ALL\n')
  await writeFile(join(packageRoot, 'mod_info.yaml'), 'version: 0.6.0\n')
  return { root, game, mods, packageRoot }
}

describe('Oxygen Not Included installer', () => {
  it('accepts only the official ONI release naming and URL', () => {
    const manifest = parseOniDistributionManifest({
      schemaVersion: 1,
      tag: 'oni-v0.6.0',
      version: '0.6.0',
      archive: {
        name: 'dsh-xiaotangyuan-game-oni-0.6.0.zip',
        url: 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/oni-v0.6.0/dsh-xiaotangyuan-game-oni-0.6.0.zip',
        size: 1024,
        sha256: 'a'.repeat(64),
      },
    })
    expect(manifest.version).toBe('0.6.0')
    expect(() => parseOniDistributionManifest({
      ...manifest,
      archive: { ...manifest.archive, url: 'https://example.com/oni.zip' },
    })).toThrow('官方发布地址')
  })

  it('detects the game and installed C# Bridge', async () => {
    const { game, mods } = await fixture()
    const mod = join(mods, 'Local', 'DoubaoAI')
    await mkdir(mod, { recursive: true })
    await writeFile(join(mod, 'DoubaoAI.ONI.dll'), 'bridge')
    await writeFile(join(mod, 'mod_info.yaml'), 'version: 0.5.0\n')
    const result = await inspectOniPath(game, mods)
    expect(result).toMatchObject({
      found: true,
      installedVersion: '0.5.0',
      bridgeInstalled: true,
      modPath: mod,
    })
  })

  it('backs up an old Bridge and installs the verified package', async () => {
    const { game, mods, packageRoot } = await fixture()
    const mod = join(mods, 'Local', 'DoubaoAI')
    await mkdir(mod, { recursive: true })
    await writeFile(join(mod, 'DoubaoAI.ONI.dll'), 'old bridge')
    await writeFile(join(mod, 'mod_info.yaml'), 'version: 0.5.0\n')
    await writeFile(join(mod, 'config.json'), '{"ApiKey":"legacy-secret"}\n')

    const result = await applyOniPackage(
      game,
      packageRoot,
      '0.6.0',
      AbortSignal.timeout(5_000),
      mods,
    )

    expect(result.action).toBe('updated')
    expect(result.backupPath).toBeDefined()
    expect(await readFile(join(result.modPath, 'DoubaoAI.ONI.dll'), 'utf8')).toBe('new bridge')
    expect(await readFile(join(result.backupPath!, 'config.json'), 'utf8')).toContain('legacy-secret')
    await expect(readFile(join(result.modPath, 'config.json'), 'utf8')).rejects.toThrow()
  })

  it('rejects a mismatched package without touching the old install', async () => {
    const { game, mods, packageRoot } = await fixture()
    const mod = join(mods, 'Local', 'DoubaoAI')
    await mkdir(mod, { recursive: true })
    await writeFile(join(mod, 'DoubaoAI.ONI.dll'), 'old bridge')
    await writeFile(join(mod, 'mod_info.yaml'), 'version: 0.5.0\n')

    await expect(applyOniPackage(
      game,
      packageRoot,
      '0.7.0',
      AbortSignal.timeout(5_000),
      mods,
    )).rejects.toThrow('版本不一致')
    expect(await readFile(join(mod, 'DoubaoAI.ONI.dll'), 'utf8')).toBe('old bridge')
  })
})
