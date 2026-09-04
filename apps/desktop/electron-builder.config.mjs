import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopRoot, '../..')
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'integrations/xiaotangyuan/manifest.json'), 'utf8'))
const archiveName = `qimidandapigu-dsh-xiaotangyuan-game-${manifest.development.expectedVersion}.tgz`
const workArchiveName = `qimidandapigu-dsh-work-orchestrator-${manifest.workOrchestrator.expectedVersion}.tgz`

export default {
  appId: 'com.qimidandapigu.ai-native-game-harness',
  productName: 'AI Native Game Harness 游戏版',
  electronVersion: '43.4.1',
  asar: true,
  directories: {
    output: resolve(repoRoot, 'distribution/desktop'),
  },
  files: [
    'src/**/*',
    'node_modules/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: resolve(repoRoot, '.artifacts/desktop-runtime/package.json'),
      to: 'runtime/package.json',
    },
    {
      from: resolve(repoRoot, '.artifacts/desktop-runtime/node_modules'),
      to: 'runtime/node_modules',
      filter: ['**/*'],
    },
    {
      from: resolve(repoRoot, `.artifacts/xiaotangyuan/${archiveName}`),
      to: `plugins/${archiveName}`,
    },
    {
      from: resolve(repoRoot, `.artifacts/xiaotangyuan/${workArchiveName}`),
      to: `plugins/${workArchiveName}`,
    },
    {
      from: resolve(repoRoot, 'integrations/xiaotangyuan/desktop.patch.yml'),
      to: 'config/xiaotangyuan.patch.yml',
    },
    {
      from: resolve(repoRoot, '.artifacts/stardew'),
      to: 'stardew',
      filter: ['**/*'],
    },
  ],
  win: {
    target: ['nsis'],
    icon: resolve(desktopRoot, 'assets/game-edition-icon.ico'),
    artifactName: 'AI-Native-Game-Harness-Game-Edition-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'AI Native Game Harness 游戏版',
  },
}
