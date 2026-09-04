import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ADAPTER_FOLDER = 'StardewAgentMod'
const COMPANION_FOLDER = 'XiaoTangYuanCompanion'

export async function readBundledStardewSource(stardewRoot) {
  const descriptor = JSON.parse(await readFile(join(stardewRoot, 'bundle.json'), 'utf8'))
  if (descriptor?.schemaVersion !== 1
    || !/^\d+\.\d+\.\d+$/.test(descriptor.version ?? '')
    || descriptor.adapterFolder !== ADAPTER_FOLDER
    || descriptor.companionFolder !== COMPANION_FOLDER) {
    throw new Error('客户端内置的 Stardew MOD 资源清单无效。')
  }
  const source = {
    version: descriptor.version,
    adapterPath: join(stardewRoot, ADAPTER_FOLDER),
    companionPath: join(stardewRoot, COMPANION_FOLDER),
  }
  await Promise.all([
    access(join(source.adapterPath, 'manifest.json'), constants.R_OK),
    access(join(source.adapterPath, 'StardewAgentMod.dll'), constants.R_OK),
    access(join(source.companionPath, 'manifest.json'), constants.R_OK),
  ])
  return source
}

export function presentStardewReconcileResult(result) {
  const common = {
    code: result.status,
    checkedAt: new Date().toISOString(),
    version: result.version,
    changed: result.changed,
    packages: result.packages ?? [],
  }
  switch (result.status) {
    case 'changed':
      return {
        ...common,
        phase: 'ready',
        title: 'Stardew MOD 已自动修复',
        detail: `${result.summary}；如果 Stardew Valley 已经打开，请重启游戏后使用新版本。`,
      }
    case 'current':
      return { ...common, phase: 'ready', title: 'Stardew MOD 已是最新版本', detail: result.summary }
    case 'smapi-missing':
      return { ...common, phase: 'attention', title: '需要先安装 SMAPI', detail: result.summary }
    case 'game-not-found':
      return { ...common, phase: 'attention', title: '尚未找到 Stardew Valley', detail: result.summary }
    default:
      throw new Error(`未知的 Stardew 检查结果：${result.status}`)
  }
}

export async function reconcileDesktopStardew({ installerPath, stardewRoot, gamePath, signal }) {
  const source = await readBundledStardewSource(stardewRoot)
  const installer = await import(pathToFileURL(installerPath).href)
  if (typeof installer.reconcileBundledStardewInstallation !== 'function') {
    throw new Error('小汤圆插件未导出 Desktop Stardew 安装接口。')
  }
  const result = await installer.reconcileBundledStardewInstallation(gamePath, source, signal)
  return presentStardewReconcileResult(result)
}
