import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyDontStarveInstaller,
  inspectDontStarvePath,
  parseDontStarveDistributionManifest,
} from '../src/installation/dont-starve-together.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string, game: string, installer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dst-test-'))
  roots.push(root)
  const game = join(root, "Don't Starve Together")
  const installer = join(root, 'package')
  await mkdir(join(game, 'data', 'databundles'), { recursive: true })
  await writeFile(join(game, 'data', 'databundles', 'scripts.zip'), 'marker')
  await mkdir(installer)
  await writeFile(join(installer, '安装切斯特AI.exe'), 'verified installer')
  return { root, game, installer }
}

describe('Dont Starve Together installer', () => {
  it('accepts only an exact official release manifest', () => {
    const manifest = parseDontStarveDistributionManifest({
      schemaVersion: 1,
      tag: 'dont-starve-v0.2.17',
      version: '0.2.17',
      archive: {
        name: 'dsh-xiaotangyuan-game-dont-starve-0.2.17.zip',
        url: 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/dont-starve-v0.2.17/dsh-xiaotangyuan-game-dont-starve-0.2.17.zip',
        size: 1024,
        sha256: 'a'.repeat(64),
      },
    })
    expect(manifest.version).toBe('0.2.17')
    expect(() => parseDontStarveDistributionManifest({
      ...manifest,
      archive: { ...manifest.archive, url: 'https://example.com/package.zip' },
    })).toThrow('官方发布地址')
  })

  it('detects the game, installed Mod version, and launcher', async () => {
    const { game } = await fixture()
    const mod = join(game, 'mods', 'dont-starve-ai-mod')
    await mkdir(mod, { recursive: true })
    await writeFile(join(mod, 'modinfo.lua'), 'version = "0.2.17"\n')
    await writeFile(join(mod, 'ChesterAI.exe'), 'launcher')
    const result = await inspectDontStarvePath(game)
    expect(result).toMatchObject({ found: true, installedVersion: '0.2.17', launcherInstalled: true })
    expect(result?.steamLaunchOption).toContain('ChesterAI.exe')
  })

  it('backs up an old install and preserves only safe Adapter configuration', async () => {
    const { game, installer } = await fixture()
    const mod = join(game, 'mods', 'dont-starve-ai-mod')
    await mkdir(mod, { recursive: true })
    await writeFile(join(mod, 'modinfo.lua'), 'version = "0.1.0"\n')
    await writeFile(join(mod, 'ChesterAI.exe'), 'old launcher')
    await writeFile(join(mod, '.env'), 'AI_API_KEY=legacy\nHARNESS_GATEWAY_URL=ws://127.0.0.1:32145\n')

    const result = await applyDontStarveInstaller(
      game,
      installer,
      '0.2.17',
      AbortSignal.timeout(5_000),
      async (_installer, target) => {
        const destination = join(target, 'mods', 'dont-starve-ai-mod')
        await mkdir(destination, { recursive: true })
        await writeFile(join(destination, 'modinfo.lua'), 'version = "0.2.17"\n')
        await writeFile(join(destination, 'ChesterAI.exe'), 'new launcher')
      },
    )

    expect(result.action).toBe('updated')
    expect(result.backupPath).toBeDefined()
    expect(await readFile(join(result.modPath, '.env'), 'utf8')).toBe(
      'HARNESS_GATEWAY_URL=ws://127.0.0.1:32145\n',
    )
    expect(await readFile(join(result.backupPath!, 'modinfo.lua'), 'utf8')).toContain('0.1.0')
  })

  it('rolls back when post-install verification fails', async () => {
    const { game, installer } = await fixture()
    const mod = join(game, 'mods', 'dont-starve-ai-mod')
    await mkdir(mod, { recursive: true })
    await writeFile(join(mod, 'modinfo.lua'), 'version = "0.1.0"\n')
    await writeFile(join(mod, 'ChesterAI.exe'), 'old launcher')

    await expect(applyDontStarveInstaller(
      game,
      installer,
      '0.2.17',
      AbortSignal.timeout(5_000),
      async (_installer, target) => {
        const destination = join(target, 'mods', 'dont-starve-ai-mod')
        await mkdir(destination, { recursive: true })
        await writeFile(join(destination, 'modinfo.lua'), 'version = "broken"\n')
      },
    )).rejects.toThrow('安装后验证失败')
    expect(await readFile(join(mod, 'modinfo.lua'), 'utf8')).toContain('0.1.0')
    expect(await readFile(join(mod, 'ChesterAI.exe'), 'utf8')).toBe('old launcher')
  })
})
