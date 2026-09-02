import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('AI Native Game Harness branding', () => {
  it('keeps the desktop window title on the product brand', () => {
    const main = read('apps/desktop/src/main.mjs')

    expect(main).toContain("const PRODUCT_TITLE = 'AI Native Game Harness 游戏版'")
    expect(main).toContain("mainWindow.on('page-title-updated'")
    expect(main).toContain('event.preventDefault()')
    expect(main).toContain('mainWindow?.setTitle(PRODUCT_TITLE)')
    expect(main).toContain("icon: join(desktopRoot, 'src', 'assets', 'mascot-logo.png')")
    expect(main).toContain("name.textContent = 'AI Native Game Harness'")
    expect(main).toContain("window.__aiNativeBrandObserver = new MutationObserver")
    expect(main).toContain("document.querySelector('[class*=\"_brandIdentity\"]')")
    expect(main).toContain("document.querySelector('[class*=\"_fishHitbox\"]')")
    expect(main).toContain('heroMark.replaceChildren(makeMascot(42))')
  })

  it('does not expose the upstream product name in player-facing strings', () => {
    const playerFacingFiles = [
      'apps/desktop/src/main.mjs',
      'apps/desktop/src/product.html',
      'apps/desktop/src/status.html',
      'games/stardew-valley/adapter/ModEntry.cs',
      'games/dont-starve-together/README.md',
      'games/dont-starve-together/game-mod/modinfo.lua',
      'games/dont-starve-together/src/dont_starve_ai_mod/app.py',
      'games/dont-starve-together/src/dont_starve_ai_mod/cli.py',
      'games/dont-starve-together/src/dont_starve_ai_mod/harness_client.py',
      'games/oxygen-not-included/adapter/src/index.ts',
      'games/oxygen-not-included/adapter/README.md',
      'games/oxygen-not-included/bridge/README.md',
      'games/oxygen-not-included/bridge/docs/QUICK_START.md',
      'games/oxygen-not-included/bridge/src/ConfigManager.cs',
      'games/oxygen-not-included/bridge/src/DoubaoAIRuntime.cs',
      'plugins/xiaotangyuan-game/README.md',
      'plugins/xiaotangyuan-game/src/tools/game-mod-tools.ts',
    ]

    for (const path of playerFacingFiles) {
      expect(read(path), path).not.toContain('DeepSeek Harness')
      expect(read(path), path).not.toMatch(/\bAIHarness\b/)
    }

    for (const path of [
      'apps/desktop/src/status.html',
      'apps/desktop/src/product.html',
      'apps/desktop/src/product.js',
    ]) {
      expect(read(path), path).not.toMatch(/\bDSH\b/)
    }
  })

  it('uses the front-facing mascot logo throughout the desktop UI', () => {
    const product = read('apps/desktop/src/product.html')
    const status = read('apps/desktop/src/status.html')

    expect(product).toContain('src="assets/mascot-logo.png"')
    expect(product).not.toContain('<div class="brand-mark"')
    expect(status).toContain('src="assets/mascot-logo.png"')
    expect(existsSync(resolve(root, 'apps/desktop/src/assets/mascot-logo.png'))).toBe(true)
    expect(existsSync(resolve(root, 'apps/desktop/assets/game-edition-icon.ico'))).toBe(true)
  })

  it('opens the original Harness by default and keeps explicit two-way navigation', () => {
    const main = read('apps/desktop/src/main.mjs')
    const preload = read('apps/desktop/src/preload.cjs')
    const product = read('apps/desktop/src/product.html')
    const productScript = read('apps/desktop/src/product.js')

    expect(main).toContain('await showHarnessPage()')
    expect(main).toContain("text: '🎮 进入游戏版'")
    expect(main).toContain("text: '✓ 自动测评'")
    expect(main).toContain("href: 'ai-native-game-harness://game'")
    expect(main).toContain("href: 'ai-native-game-harness://evaluation'")
    expect(main).toContain("mainWindow.webContents.on('will-navigate'")
    expect(main).toContain("mainWindow.webContents.on('before-input-event'")
    expect(main).toContain("label: '原 Harness 页面'")
    expect(main).toContain("label: '游戏版页面'")
    expect(main).toContain("label: '自动测评'")
    expect(preload).toContain("ipcRenderer.invoke('navigation:show-harness')")
    expect(preload).toContain("ipcRenderer.invoke('navigation:show-game')")
    expect(product).toContain('id="return-harness"')
    expect(productScript).toContain("window.location.href = 'ai-native-game-harness://harness'")
  })

  it('exposes automatic evaluation as an embedded product page', () => {
    const main = read('apps/desktop/src/main.mjs')
    const preload = read('apps/desktop/src/preload.cjs')
    const product = read('apps/desktop/src/product.html')
    const productScript = read('apps/desktop/src/product.js')

    expect(main).toContain("ipcMain.handle('evaluation:catalog'")
    expect(main).toContain("ipcMain.handle('evaluation:run'")
    expect(preload).toContain("ipcRenderer.invoke('evaluation:catalog')")
    expect(preload).toContain("ipcRenderer.invoke('evaluation:run'")
    expect(product).toContain('data-page="evaluation"')
    expect(product).toContain('id="page-evaluation"')
    expect(product).toContain('id="run-dst-butterfly-evaluation"')
    expect(product).toContain('实际运行模型')
    expect(product).not.toContain('<select id="evaluation-model"')
    expect(productScript).toContain("evaluation.run('dst.learn-and-run-butterfly'")
    expect(productScript).toContain("new URLSearchParams(location.search).get('page')")
  })
})
