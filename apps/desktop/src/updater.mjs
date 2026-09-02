const DEFAULT_CHECK_DELAY_MS = 15_000

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

export function desktopUpdatesEnabled({ isPackaged, platform, disabled = false }) {
  return isPackaged === true && platform === 'win32' && disabled !== true
}

export class DesktopUpdaterController {
  #autoUpdater
  #clearTimer
  #dialog
  #getWindow
  #log
  #promptedVersions = new Set()
  #schedule
  #timer

  constructor({ autoUpdater, dialog, getWindow, log, schedule = setTimeout, clearTimer = clearTimeout }) {
    this.#autoUpdater = autoUpdater
    this.#dialog = dialog
    this.#getWindow = getWindow
    this.#log = log
    this.#schedule = schedule
    this.#clearTimer = clearTimer
  }

  start({ delayMs = DEFAULT_CHECK_DELAY_MS } = {}) {
    const updater = this.#autoUpdater
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.logger = {
      debug: value => this.#write('debug', value),
      info: value => this.#write('info', value),
      warn: value => this.#write('warn', value),
      error: value => this.#write('error', value),
    }

    updater.on('checking-for-update', this.#checking)
    updater.on('update-available', this.#available)
    updater.on('update-not-available', this.#notAvailable)
    updater.on('download-progress', this.#progress)
    updater.on('update-downloaded', this.#downloaded)
    updater.on('error', this.#error)

    this.#timer = this.#schedule(() => void this.check(), delayMs)
    this.#write('info', `startup check scheduled in ${delayMs}ms`)
    return this
  }

  async check() {
    try {
      return await this.#autoUpdater.checkForUpdates()
    } catch (error) {
      this.#write('warn', `update check failed without blocking startup: ${message(error)}`)
      return undefined
    }
  }

  stop() {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer)
    this.#timer = undefined
    const updater = this.#autoUpdater
    updater.removeListener('checking-for-update', this.#checking)
    updater.removeListener('update-available', this.#available)
    updater.removeListener('update-not-available', this.#notAvailable)
    updater.removeListener('download-progress', this.#progress)
    updater.removeListener('update-downloaded', this.#downloaded)
    updater.removeListener('error', this.#error)
  }

  #checking = () => this.#write('info', 'checking for a Windows update')
  #available = info => this.#write('info', `update available: ${String(info?.version ?? 'unknown')}`)
  #notAvailable = info => this.#write('info', `already current: ${String(info?.version ?? 'unknown')}`)
  #progress = progress => this.#write('debug', `download ${Math.round(Number(progress?.percent ?? 0))}%`)
  #error = error => this.#write('warn', `updater error: ${message(error)}`)

  #downloaded = info => {
    const version = String(info?.version ?? '新版本')
    if (this.#promptedVersions.has(version)) return
    this.#promptedVersions.add(version)
    this.#write('info', `update downloaded: ${version}`)
    const options = {
      type: 'info',
      title: '更新已下载',
      message: `AI Native Game Harness ${version} 已准备好`,
      detail: '请正常退出 Harness。程序会在退出后完成安装，下次启动就是新版本；游戏存档和 Harness 用户数据不会被删除。',
      buttons: ['知道了'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const window = this.#getWindow?.()
    const shown = window && !window.isDestroyed?.()
      ? this.#dialog.showMessageBox(window, options)
      : this.#dialog.showMessageBox(options)
    void Promise.resolve(shown).catch(error => this.#write('warn', `update prompt failed: ${message(error)}`))
  }

  #write(level, value) {
    this.#log(`[updater:${level}] ${String(value)}\n`)
  }
}

export async function startDesktopUpdater({
  app,
  dialog,
  getWindow,
  log,
  platform = process.platform,
  disabled = process.env.AI_GAME_HARNESS_DISABLE_UPDATES === '1',
  autoUpdater,
  schedule,
  clearTimer,
  delayMs,
}) {
  if (!desktopUpdatesEnabled({ isPackaged: app.isPackaged, platform, disabled })) {
    log(`[updater:info] disabled (packaged=${String(app.isPackaged)}, platform=${platform}, disabled=${String(disabled)})\n`)
    return undefined
  }

  let updater = autoUpdater
  if (!updater) {
    const electronUpdater = await import('electron-updater')
    updater = electronUpdater.default.autoUpdater
  }
  return new DesktopUpdaterController({ autoUpdater: updater, dialog, getWindow, log, schedule, clearTimer }).start({ delayMs })
}

export { DEFAULT_CHECK_DELAY_MS }
