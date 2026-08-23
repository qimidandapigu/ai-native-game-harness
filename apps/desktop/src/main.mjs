import { createServer } from 'node:net'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, shell, utilityProcess } from 'electron'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '../..')
let mainWindow
let dshProcess
let dshExitCode = null
let quitting = false

function sendStatus(message, detail = '') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('harness-status', { message, detail })
  }
}

function runtimePaths() {
  const packaged = app.isPackaged
  const resourceRoot = packaged ? process.resourcesPath : repoRoot
  const pluginRoot = packaged
    ? join(resourceRoot, 'plugins')
    : join(repoRoot, '.artifacts', 'xiaotangyuan')
  const patchPath = packaged
    ? join(resourceRoot, 'config', 'xiaotangyuan.patch.yml')
    : join(repoRoot, 'integrations', 'xiaotangyuan', 'smoke.patch.yml')
  const pluginArchive = readdirSync(pluginRoot)
    .filter((name) => /^qimidandapigu-dsh-xiaotangyuan-game-.+\.tgz$/.test(name))
    .sort()
    .at(-1)
  if (!pluginArchive) throw new Error(`未找到小汤圆插件包：${pluginRoot}`)

  const runtimeRequire = packaged
    ? createRequire(join(resourceRoot, 'runtime', 'package.json'))
    : require
  const dshPackage = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
  const dshBin = join(dirname(dshPackage), 'lib', 'bin.js')

  return {
    dshBin,
    patchPath,
    pluginPath: join(pluginRoot, pluginArchive),
    pluginVersion: pluginArchive.replace(/^.*-game-/, '').replace(/\.tgz$/, ''),
  }
}

function childEnvironment(paths) {
  return {
    ...process.env,
    DSH_HOME: join(app.getPath('userData'), 'dsh-home'),
    DSH_DISABLE_HMR: app.isPackaged ? '1' : process.env.DSH_DISABLE_HMR,
  }
}

function appendRuntimeLog(text) {
  const logRoot = join(app.getPath('userData'), 'logs')
  mkdirSync(logRoot, { recursive: true })
  appendFileSync(join(logRoot, 'runtime.log'), text)
}

function forkDsh(args, paths, serviceName) {
  return utilityProcess.fork(paths.dshBin, args, {
    cwd: app.getPath('userData'),
    env: childEnvironment(paths),
    execArgv: ['--expose-internals'],
    serviceName,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runDshOnce(args, paths) {
  return new Promise((resolveRun, rejectRun) => {
    const child = forkDsh(args, paths, 'AI Native Game Harness Setup')
    let output = ''
    child.stdout?.on('data', (data) => { output += data.toString() })
    child.stderr?.on('data', (data) => { output += data.toString() })
    child.once('error', (_type, location, report) => rejectRun(new Error(`${location}\n${report}`)))
    child.once('exit', (code) => {
      if (code === 0) resolveRun(output)
      else rejectRun(new Error(output.trim() || `DSH 命令退出，代码 ${code}`))
    })
  })
}

async function ensurePlugin(paths) {
  const stateRoot = join(app.getPath('userData'), 'runtime-state')
  const markerPath = join(stateRoot, 'xiaotangyuan.version')
  const installedVersion = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : ''

  if (app.isPackaged) {
    const profileRoot = join(app.getPath('userData'), 'dsh-home', 'profiles', 'web')
    const profilePath = join(profileRoot, 'package.json')
    const profile = existsSync(profilePath)
      ? JSON.parse(readFileSync(profilePath, 'utf8'))
      : { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
    const bundles = profile.dsh?.profile?.bundles ?? []
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@qimidandapigu/dsh-xiaotangyuan-game']) {
      if (!bundles.includes(name)) bundles.push(name)
    }
    profile.dsh = { ...profile.dsh, profile: { ...profile.dsh?.profile, bundles } }
    mkdirSync(profileRoot, { recursive: true })
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(markerPath, `${paths.pluginVersion}\n`)
    return
  }

  if (installedVersion === paths.pluginVersion) return

  sendStatus('正在安装游戏插件', `小汤圆 ${paths.pluginVersion}`)
  await runDshOnce(['plugin', '--profile', 'web', 'add', paths.pluginPath], paths)
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(markerPath, `${paths.pluginVersion}\n`)
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForWeb(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (dshExitCode !== null) throw new Error(`DSH 在界面就绪前退出，代码 ${dshExitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
  throw new Error('等待 DSH 界面启动超时')
}

async function startRuntime() {
  const paths = runtimePaths()
  await ensurePlugin(paths)
  const port = await getFreePort()
  const url = `http://127.0.0.1:${port}`
  sendStatus('正在启动 AI Runtime', url)

  dshExitCode = null
  dshProcess = forkDsh([
    'web',
    '--patch', paths.patchPath,
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(port),
  ], paths, 'AI Native Game Harness Runtime')

  let recentLog = ''
  const collect = (data) => {
    const text = data.toString()
    recentLog = `${recentLog}${text}`.slice(-12_000)
    appendRuntimeLog(text)
  }
  dshProcess.stdout?.on('data', collect)
  dshProcess.stderr?.on('data', collect)
  dshProcess.once('exit', (code) => {
    dshExitCode = code
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(join(desktopRoot, 'src', 'status.html'))
      sendStatus('AI Runtime 已停止', recentLog || `退出代码 ${code}`)
    }
  })

  await waitForWeb(url, dshProcess)
  await mainWindow.loadURL(url)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'AI Native Game Harness',
    backgroundColor: '#08131d',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(desktopRoot, 'src', 'preload.mjs'),
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void mainWindow.loadFile(join(desktopRoot, 'src', 'status.html')).then(() => startRuntime()).catch(async (error) => {
    sendStatus('启动失败', error instanceof Error ? error.message : String(error))
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'AI Native Game Harness 启动失败',
      message: '内置 DSH Runtime 未能启动。',
      detail: error instanceof Error ? error.message : String(error),
    })
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  quitting = true
  if (dshProcess?.pid) dshProcess.kill()
})
