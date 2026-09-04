import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Desktop Stardew self-healing wiring', () => {
  it('runs the bundled installer without blocking Runtime startup on repair failure', () => {
    const main = read('apps/desktop/src/main.mjs')
    expect(main).toContain('await reconcileStardewInstallation(paths)')
    expect(main).toContain("code: 'repair-failed'")
    expect(main).toContain("ipcMain.handle('stardew:reconcile'")
  })

  it('advertises the Desktop dynamic Adapter Protocol endpoint to Stardew', () => {
    const main = read('apps/desktop/src/main.mjs')
    expect(main).toContain("adapterProtocolUrl: 'ws://127.0.0.1:${adapterPort}/adapter'")
    expect(main).toContain('pushToTalkKey: v')
  })

  it('packages both Stardew resources and the macOS Media Host path', () => {
    const builder = read('apps/desktop/electron-builder.config.mjs')
    const plugin = JSON.parse(read('plugins/xiaotangyuan-game/package.json'))
    expect(builder).toContain("resolve(repoRoot, '.artifacts/stardew')")
    expect(plugin.files).toContain('media/macos-arm64/XtyMediaHost')
    expect(plugin.exports).toHaveProperty('./stardew-installer')
  })

  it('exposes the updater status inside the product UI', () => {
    expect(read('apps/desktop/src/preload.cjs')).toContain("ipcRenderer.invoke('stardew:installation-status')")
    expect(read('apps/desktop/src/product.html')).toContain('id="stardew-mod-health"')
    expect(read('apps/desktop/src/product.js')).toContain('renderStardewInstallationStatus')
    expect(read('apps/desktop/src/product.js')).toContain('initialStardewStatus && !receivedStardewStatusEvent')
  })

  it('keeps the Volcengine secret in the main process and exposes only local configuration actions', () => {
    const main = read('apps/desktop/src/main.mjs')
    const preload = read('apps/desktop/src/preload.cjs')
    const product = read('apps/desktop/src/product.js')
    expect(main).toContain("from './voice-credentials.mjs'")
    expect(main).toContain("ipcMain.handle('voice:credential-status'")
    expect(main).toContain("ipcMain.handle('voice:configure'")
    expect(preload).toContain("ipcRenderer.invoke('voice:credential-status')")
    expect(preload).toContain("ipcRenderer.invoke('voice:configure'")
    expect(read('apps/desktop/src/product.html')).toContain('id="voice-credential-form"')
    expect(product).toContain('renderVoiceCredentialStatus')
  })

  it('shows an explicit Chinese game connection state on both Desktop pages', () => {
    const main = read('apps/desktop/src/main.mjs')
    const product = read('apps/desktop/src/product.js')
    expect(main).toContain('游戏已接入')
    expect(product).toContain("connected ? '游戏已接入'")
  })

  it('runs the speech smoke against the same versioned DSH credential store and TTS route as Desktop', () => {
    const smoke = read('scripts/smoke-speech.mjs')
    expect(smoke).toContain("@deepseek-ai/dsh-credentials-local")
    expect(smoke).toContain("parsed.refs.get(credentialRef)")
    expect(smoke).toContain("'seed-tts-2.0'")
    expect(smoke).toContain("'ICL_uranus_zh_female_yuanqitianmei_tob'")
  })

  it('installs development tarballs through a content-addressed path', () => {
    expect(read('apps/desktop/src/main.mjs')).toContain('pluginInstallPath')
    expect(read('scripts/prepare-desktop-dev.mjs')).toContain('item.installPath')
  })

  it('accepts a live adapter and probes voice configuration in the isolated Desktop smoke', () => {
    const smoke = read('scripts/smoke-desktop-startup.mjs')
    expect(smoke).toContain("AI_GAME_HARNESS_DEMO: '1'")
    expect(smoke).toContain('AI_GAME_HARNESS_ADAPTER_PORT: String(desktopAdapterPort)')
    expect(smoke).toContain("voiceReady: Boolean(window.harnessDesktop?.voice && typeof window.harnessDesktop.voice.status === 'function')")
    expect(smoke).toContain("liveStatus: document.querySelector('#live-status')?.textContent")
    expect(smoke).toContain("lastConnectionProbe?.liveStatus === '游戏已接入'")
    expect(smoke).toContain("Object.hasOwn(voiceStatus, 'value')")
  })
})
