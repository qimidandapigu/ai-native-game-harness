import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  presentStardewReconcileResult,
  readBundledStardewSource,
} from '../../apps/desktop/src/stardew-bootstrap.mjs'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function bundleFixture(descriptor = {
  schemaVersion: 1,
  version: '0.8.0',
  adapterFolder: 'StardewAgentMod',
  companionFolder: 'XiaoTangYuanCompanion',
}) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-stardew-bundle-'))
  temporaryPaths.push(root)
  await mkdir(join(root, 'StardewAgentMod'))
  await mkdir(join(root, 'XiaoTangYuanCompanion'))
  await writeFile(join(root, 'bundle.json'), JSON.stringify(descriptor))
  await writeFile(join(root, 'StardewAgentMod', 'manifest.json'), '{}')
  await writeFile(join(root, 'StardewAgentMod', 'StardewAgentMod.dll'), '')
  await writeFile(join(root, 'XiaoTangYuanCompanion', 'manifest.json'), '{}')
  return root
}

describe('Desktop Stardew bootstrap seam', () => {
  it('resolves only the fixed first-party folders from a valid bundle', async () => {
    const root = await bundleFixture()
    await expect(readBundledStardewSource(root)).resolves.toEqual({
      version: '0.8.0',
      adapterPath: join(root, 'StardewAgentMod'),
      companionPath: join(root, 'XiaoTangYuanCompanion'),
    })
  })

  it('rejects folder substitution in a bundled descriptor', async () => {
    const root = await bundleFixture({
      schemaVersion: 1,
      version: '0.8.0',
      adapterFolder: '../OtherMod',
      companionFolder: 'XiaoTangYuanCompanion',
    })
    await expect(readBundledStardewSource(root)).rejects.toThrow('资源清单无效')
  })

  it('maps updater outcomes into client-visible health states', () => {
    expect(presentStardewReconcileResult({
      status: 'changed', version: '0.8.0', changed: true, summary: 'updated', packages: [],
    })).toMatchObject({ phase: 'ready', code: 'changed', title: 'Stardew MOD 已自动修复' })
    expect(presentStardewReconcileResult({
      status: 'smapi-missing', version: '0.8.0', changed: false, summary: 'missing', packages: [],
    })).toMatchObject({ phase: 'attention', code: 'smapi-missing', title: '需要先安装 SMAPI' })
  })
})
