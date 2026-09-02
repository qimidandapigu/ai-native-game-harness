import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopUpdaterController,
  desktopUpdatesEnabled,
  startDesktopUpdater,
} from '../../apps/desktop/src/updater.mjs'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = true
  logger: unknown
  checkForUpdates = vi.fn(async () => ({ updateInfo: { version: '0.1.1' } }))
}

describe('Windows desktop updater', () => {
  it('enables only packaged Windows builds', () => {
    expect(desktopUpdatesEnabled({ isPackaged: true, platform: 'win32' })).toBe(true)
    expect(desktopUpdatesEnabled({ isPackaged: false, platform: 'win32' })).toBe(false)
    expect(desktopUpdatesEnabled({ isPackaged: true, platform: 'darwin' })).toBe(false)
    expect(desktopUpdatesEnabled({ isPackaged: true, platform: 'win32', disabled: true })).toBe(false)
  })

  it('checks after startup, downloads in the background and installs on normal exit', async () => {
    const updater = new FakeUpdater()
    const log = vi.fn()
    let scheduled: (() => void) | undefined
    const controller = new DesktopUpdaterController({
      autoUpdater: updater,
      dialog: { showMessageBox: vi.fn() },
      getWindow: () => undefined,
      log,
      schedule: (callback: () => void) => { scheduled = callback; return 17 as never },
      clearTimer: vi.fn(),
    }).start({ delayMs: 10 })

    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.allowPrerelease).toBe(false)
    scheduled?.()
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce())
    expect(log).toHaveBeenCalledWith(expect.stringContaining('startup check scheduled'))
    controller.stop()
  })

  it('prompts once after download and states that data is preserved', async () => {
    const updater = new FakeUpdater()
    const showMessageBox = vi.fn(async () => ({ response: 0 }))
    const controller = new DesktopUpdaterController({
      autoUpdater: updater,
      dialog: { showMessageBox },
      getWindow: () => undefined,
      log: vi.fn(),
      schedule: () => 1 as never,
      clearTimer: vi.fn(),
    }).start()

    updater.emit('update-downloaded', { version: '0.1.2' })
    updater.emit('update-downloaded', { version: '0.1.2' })
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce())
    expect(showMessageBox.mock.calls[0]?.[0]).toMatchObject({
      title: '更新已下载',
      detail: expect.stringContaining('用户数据不会被删除'),
    })
    controller.stop()
  })

  it('does not block startup when update checking fails or is disabled', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    const log = vi.fn()
    const controller = new DesktopUpdaterController({
      autoUpdater: updater,
      dialog: { showMessageBox: vi.fn() },
      getWindow: () => undefined,
      log,
      schedule: () => 1 as never,
      clearTimer: vi.fn(),
    })
    await expect(controller.check()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('without blocking startup'))

    await expect(startDesktopUpdater({
      app: { isPackaged: false },
      dialog: { showMessageBox: vi.fn() },
      getWindow: () => undefined,
      log,
      platform: 'win32',
    })).resolves.toBeUndefined()
  })

  it('ships update metadata and explicitly preserves AppData during uninstall', () => {
    const root = resolve(import.meta.dirname, '../..')
    const builder = readFileSync(resolve(root, 'apps/desktop/electron-builder.config.mjs'), 'utf8')
    const prepare = readFileSync(resolve(root, 'scripts/prepare-desktop-runtime.ps1'), 'utf8')
    const manifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'))
    expect(manifest.dependencies['electron-updater']).toBe('6.8.9')
    expect(builder).toContain("provider: 'generic'")
    expect(builder).toContain('releases/download/desktop-updates')
    expect(builder).toContain('deleteAppDataOnUninstall: false')
    expect(prepare).toContain("$desktopVersion = [string]$desktopPackage.version")
    expect(prepare).toContain("'electron-updater' = $electronUpdaterVersion")
  })
})
