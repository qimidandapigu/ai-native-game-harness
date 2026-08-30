import { createServer } from 'node:net'
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess } from 'electron'
import { GamePackRegistry, readGamePackManifest } from '@ai-native-game-harness/game-pack'
import { PlatformRuntime } from './platform-runtime.mjs'
import { DshProductRuntime } from './dsh-product-runtime.mjs'
import { buildDiagnosticBundle, diagnosticFilename } from './diagnostics.mjs'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '../..')
let mainWindow
let dshProcess
let dshExitCode = null
let quitting = false
let shutdownComplete = false
let platformRuntime
let platformUnsubscribe
let dshProductRuntime
let dshProductUnsubscribe
let lastDshCoreSnapshot
let lastDshLearningSnapshot
let lastDshStorySnapshot
const pendingDshDiagnostics = []
let demoAdapterProcess
let gamePackRegistry
let runtimeWebUrl

const PRODUCT_TITLE = 'AI Native Game Harness 游戏版'

async function installGamePageEntry() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const mascotUrl = `data:image/png;base64,${readFileSync(join(desktopRoot, 'src', 'assets', 'mascot-logo.png')).toString('base64')}`
  await mainWindow.webContents.executeJavaScript(`(() => {
    const mascotUrl = ${JSON.stringify(mascotUrl)}
    const makeMascot = (size) => {
      const image = document.createElement('img')
      image.src = mascotUrl
      image.alt = ''
      Object.assign(image.style, {
        width: size + 'px', height: size + 'px', flex: '0 0 auto',
        objectFit: 'contain', imageRendering: 'pixelated'
      })
      return image
    }
    const applyProductBranding = () => {
      const identity = document.querySelector('[class*="_brandIdentity"]')
      if (identity && identity.dataset.aiNativeBrand !== 'true') {
        identity.dataset.aiNativeBrand = 'true'
        identity.replaceChildren(makeMascot(40))
        const name = document.createElement('span')
        name.textContent = 'AI Native Game Harness'
        Object.assign(name.style, { font: '700 13px/1.15 system-ui, sans-serif', letterSpacing: '.01em' })
        identity.append(name)
        Object.assign(identity.style, { display: 'flex', alignItems: 'center', gap: '8px', height: 'auto' })
      }

      const heroMark = document.querySelector('[class*="_fishHitbox"]')
      if (heroMark && heroMark.dataset.aiNativeBrand !== 'true') {
        heroMark.dataset.aiNativeBrand = 'true'
        heroMark.replaceChildren(makeMascot(42))
      }
    }
    applyProductBranding()
    if (!window.__aiNativeBrandObserver) {
      window.__aiNativeBrandObserver = new MutationObserver(() => requestAnimationFrame(applyProductBranding))
      window.__aiNativeBrandObserver.observe(document.documentElement, { childList: true, subtree: true })
    }
    if (document.getElementById('ai-native-game-page-entry')) return
    const button = document.createElement('button')
    button.id = 'ai-native-game-page-entry'
    button.type = 'button'
    button.textContent = '🎮 进入游戏版'
    button.title = '进入 AI Native Game Harness 游戏版（Ctrl+2）'
    Object.assign(button.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
      border: '1px solid rgba(255,255,255,.18)', borderRadius: '12px',
      padding: '10px 14px', background: '#123a3a', color: '#d8fff5',
      boxShadow: '0 10px 30px rgba(0,0,0,.28)', cursor: 'pointer',
      font: '600 13px system-ui, sans-serif'
    })
    button.addEventListener('click', () => { window.location.href = 'ai-native-game-harness://game' })
    document.body.append(button)
  })()`)
}

async function showHarnessPage() {
  if (!runtimeWebUrl) throw new Error('原 Harness 页面尚未就绪。')
  await mainWindow.loadURL(runtimeWebUrl)
  await installGamePageEntry()
}

async function showGamePage() {
  await mainWindow.loadFile(join(desktopRoot, 'src', 'product.html'))
}

function installApplicationMenu() {
  const navigate = (action) => {
    void action().catch((error) => {
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '页面尚未就绪',
        message: 'Harness 页面仍在启动，请稍后再试。',
        detail: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const template = [
    { label: '文件', submenu: [{ role: 'close', label: '关闭窗口' }] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ] },
    { label: '页面', submenu: [
      { label: '原 Harness 页面', accelerator: 'CmdOrCtrl+1', click: () => navigate(showHarnessPage) },
      { label: '游戏版页面', accelerator: 'CmdOrCtrl+2', click: () => navigate(showGamePage) },
    ] },
    { label: '视图', submenu: [
      { role: 'reload', label: '刷新' }, { role: 'forceReload', label: '强制刷新' },
      { type: 'separator' }, { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
    ] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function packs() {
  gamePackRegistry ??= new GamePackRegistry(join(app.getPath('userData'), 'game-packs'))
  return gamePackRegistry
}

function productGamePack(pack) {
  return {
    manifest: pack.manifest,
    installedAt: pack.installedAt,
    health: pack.health,
  }
}

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
    : join(repoRoot, 'integrations', 'xiaotangyuan', 'desktop.patch.yml')
  const pluginArchive = readdirSync(pluginRoot)
    .filter((name) => /^qimidandapigu-dsh-xiaotangyuan-game-.+\.tgz$/.test(name))
    .sort()
    .at(-1)
  if (!pluginArchive) throw new Error(`未找到小汤圆插件包：${pluginRoot}`)
  const workArchive = readdirSync(pluginRoot)
    .filter((name) => /^qimidandapigu-dsh-work-orchestrator-.+\.tgz$/.test(name))
    .sort()
    .at(-1)
  if (!workArchive) throw new Error(`未找到 Work Orchestrator 插件包：${pluginRoot}`)
  const oniArchive = app.isPackaged ? undefined : readdirSync(pluginRoot)
    .filter((name) => /^qimidandapigu-oni-adapter-.+\.tgz$/.test(name))
    .sort()
    .at(-1)
  if (!app.isPackaged && !oniArchive) throw new Error(`未找到缺氧 Adapter 包：${pluginRoot}`)

  const runtimeRequire = packaged
    ? createRequire(join(resourceRoot, 'runtime', 'package.json'))
    : require
  const dshPackage = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
  const oniPackage = packaged
    ? runtimeRequire.resolve('@qimidandapigu/oni-adapter/package.json')
    : join(repoRoot, 'games', 'oxygen-not-included', 'adapter', 'package.json')
  const dshBin = join(dirname(dshPackage), 'lib', 'bin.js')
  const oniVersion = JSON.parse(readFileSync(oniPackage, 'utf8')).version

  return {
    dshBin,
    patchPath,
    pluginPath: join(pluginRoot, pluginArchive),
    pluginVersion: pluginArchive.replace(/^.*-game-/, '').replace(/\.tgz$/, ''),
    workPluginPath: join(pluginRoot, workArchive),
    workPluginVersion: workArchive.replace(/^.*-orchestrator-/, '').replace(/\.tgz$/, ''),
    corePluginPath: packaged
      ? join(resourceRoot, 'runtime', 'node_modules', '@ai-native-game-harness', 'game-core', 'dist', 'index.js')
      : join(repoRoot, 'plugins', 'game-core', 'dist', 'index.js'),
    transportPluginPath: packaged
      ? join(resourceRoot, 'runtime', 'node_modules', '@ai-native-game-harness', 'game-transport', 'dist', 'index.js')
      : join(repoRoot, 'plugins', 'game-transport', 'dist', 'index.js'),
    learningPluginPath: packaged
      ? join(resourceRoot, 'runtime', 'node_modules', '@ai-native-game-harness', 'game-learning-binding', 'dist', 'index.js')
      : join(repoRoot, 'plugins', 'game-learning-binding', 'dist', 'index.js'),
    storyPluginPath: packaged
      ? join(resourceRoot, 'runtime', 'node_modules', '@ai-native-game-harness', 'dsh-story-generator', 'dist', 'index.js')
      : join(repoRoot, 'plugins', 'dsh-story-generator', 'dist', 'index.js'),
    oniPath: oniArchive ? join(pluginRoot, oniArchive) : undefined,
    oniVersion,
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
  try {
    appendFileSync(join(logRoot, 'runtime.log'), text)
  } catch (error) {
    if (error?.code !== 'EBUSY') throw error
    try {
      appendFileSync(join(logRoot, `runtime-${process.pid}.log`), text)
    } catch {
      // Logging must never terminate the desktop host.
    }
  }
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
      else rejectRun(new Error(output.trim() || `AI Runtime 命令退出，代码 ${code}`))
    })
  })
}

async function ensurePlugin(paths) {
  const stateRoot = join(app.getPath('userData'), 'runtime-state')
  const markerPath = join(stateRoot, 'xiaotangyuan.version')
  const expectedVersion = `${paths.pluginVersion};work=${paths.workPluginVersion};oni=${paths.oniVersion}`
  const installedVersion = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : ''

  if (app.isPackaged) {
    const profileRoot = join(app.getPath('userData'), 'dsh-home', 'profiles', 'web')
    const profilePath = join(profileRoot, 'package.json')
    const profile = existsSync(profilePath)
      ? JSON.parse(readFileSync(profilePath, 'utf8'))
      : { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
    const bundles = profile.dsh?.profile?.bundles ?? []
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@qimidandapigu/dsh-work-orchestrator', '@qimidandapigu/dsh-xiaotangyuan-game', '@qimidandapigu/oni-adapter']) {
      if (!bundles.includes(name)) bundles.push(name)
    }
    profile.dsh = { ...profile.dsh, profile: { ...profile.dsh?.profile, bundles } }
    mkdirSync(profileRoot, { recursive: true })
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
    const pluginDependency = profile.dependencies?.['@qimidandapigu/dsh-xiaotangyuan-game']
    const workDependency = profile.dependencies?.['@qimidandapigu/dsh-work-orchestrator']
    const dependenciesCurrent = pluginDependency === `file:${paths.pluginPath}`
      && workDependency === `file:${paths.workPluginPath}`
    if (installedVersion !== expectedVersion || !dependenciesCurrent) {
      sendStatus('正在更新游戏插件', `Work ${paths.workPluginVersion} / 小汤圆 ${paths.pluginVersion}`)
      await runDshOnce(['plugin', '--profile', 'web', 'add', paths.workPluginPath], paths)
      await runDshOnce(['plugin', '--profile', 'web', 'add', paths.pluginPath], paths)
    }
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(markerPath, `${expectedVersion}\n`)
    return
  }

  if (installedVersion === expectedVersion) return

  sendStatus('正在安装游戏插件', `Work ${paths.workPluginVersion} / 小汤圆 ${paths.pluginVersion} / 缺氧 Adapter ${paths.oniVersion}`)
  await runDshOnce(['plugin', '--profile', 'web', 'add', paths.workPluginPath], paths)
  await runDshOnce(['plugin', '--profile', 'web', 'add', paths.pluginPath], paths)
  await runDshOnce(['plugin', '--profile', 'web', 'add', paths.oniPath], paths)
  mkdirSync(stateRoot, { recursive: true })
  writeFileSync(markerPath, `${expectedVersion}\n`)
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
    if (dshExitCode !== null) throw new Error(`AI Runtime 在界面就绪前退出，代码 ${dshExitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
  throw new Error('等待 AI Runtime 界面启动超时')
}

function writeProductPatch(paths, adapterPort) {
  for (const pluginPath of [paths.corePluginPath, paths.transportPluginPath, paths.learningPluginPath, paths.storyPluginPath]) {
    if (!existsSync(pluginPath)) throw new Error(`产品 Runtime 插件尚未构建：${pluginPath}`)
  }
  const stateRoot = join(app.getPath('userData'), 'runtime-state')
  const productPatchPath = join(stateRoot, 'desktop-product.patch.yml')
  mkdirSync(stateRoot, { recursive: true })
  const coreUrl = pathToFileURL(paths.corePluginPath).href
  const transportUrl = pathToFileURL(paths.transportPluginPath).href
  const learningUrl = pathToFileURL(paths.learningPluginPath).href
  const storyUrl = pathToFileURL(paths.storyPluginPath).href
  const yamlString = (value) => String(value).replaceAll("'", "''")
  const storyDataRoot = yamlString(join(app.getPath('userData'), 'story'))
  const gamePackRoot = yamlString(join(app.getPath('userData'), 'game-packs'))
  writeFileSync(productPatchPath, `- id: xiaotangyuan-game\n  config:\n    media:\n      enabled: true\n      pushToTalkVirtualKey: 86\n- id: xiaotangyuan-oni-adapter\n  config:\n    adapterProtocolUrl: 'ws://127.0.0.1:${adapterPort}/adapter'\n- insert:\n    - id: ai-native-game-core-product\n      name: '${coreUrl}'\n      config:\n        productSnapshotOutput: true\n    - id: ai-native-game-transport-product\n      name: '${transportUrl}'\n      config:\n        enabled: true\n        host: 127.0.0.1\n        port: ${adapterPort}\n        path: /adapter\n        requestTimeoutMs: 10000\n    - id: ai-native-game-learning-product\n      name: '${learningUrl}'\n    - id: ai-native-game-story-product\n      name: '${storyUrl}'\n      config:\n        dataRoot: '${storyDataRoot}'\n        gamePackRoot: '${gamePackRoot}'\n        productSnapshotOutput: true\n`)
  return productPatchPath
}

function collectProductRecords(data) {
  const snapshotPrefix = 'AI_GAME_HARNESS_SNAPSHOT '
  const learningPrefix = 'AI_GAME_HARNESS_LEARNING '
  const storyPrefix = 'AI_GAME_HARNESS_STORY '
  const diagnosticPrefix = 'AI_GAME_HARNESS_DIAGNOSTIC '
  collectProductRecords.buffer = `${collectProductRecords.buffer ?? ''}${data.toString()}`
  const lines = collectProductRecords.buffer.split(/\r?\n/)
  collectProductRecords.buffer = lines.pop() ?? ''
  for (const line of lines) {
    try {
      if (line.startsWith(snapshotPrefix)) {
        lastDshCoreSnapshot = JSON.parse(line.slice(snapshotPrefix.length))
        dshProductRuntime?.attachCoreSnapshot(lastDshCoreSnapshot)
      } else if (line.startsWith(learningPrefix)) {
        lastDshLearningSnapshot = JSON.parse(line.slice(learningPrefix.length))
        dshProductRuntime?.attachLearningSnapshot(lastDshLearningSnapshot)
      } else if (line.startsWith(storyPrefix)) {
        lastDshStorySnapshot = JSON.parse(line.slice(storyPrefix.length))
        dshProductRuntime?.attachStorySnapshot(lastDshStorySnapshot)
      } else if (line.startsWith(diagnosticPrefix)) {
        const record = JSON.parse(line.slice(diagnosticPrefix.length))
        if (!dshProductRuntime?.attachDiagnosticRecord(record)) {
          pendingDshDiagnostics.push(record)
          if (pendingDshDiagnostics.length > 500) pendingDshDiagnostics.shift()
        }
      }
    } catch (error) {
      appendRuntimeLog(`[desktop] 无法解析产品记录：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

async function startRuntime() {
  sendStatus('正在检查本地运行环境', '读取插件包和版本信息…')
  appendRuntimeLog('[desktop] resolving Runtime paths\n')
  const paths = runtimePaths()
  appendRuntimeLog(`[desktop] Runtime paths ready: work=${paths.workPluginVersion}; plugin=${paths.pluginVersion}; oni=${paths.oniVersion}\n`)
  sendStatus('正在检查内置游戏插件', `Work ${paths.workPluginVersion} / 小汤圆 ${paths.pluginVersion} / 缺氧 Adapter ${paths.oniVersion}`)
  await ensurePlugin(paths)
  appendRuntimeLog('[desktop] built-in plugins ready\n')
  sendStatus('正在分配本地端口', '准备 AI Runtime 和游戏 Adapter 通道…')
  const port = await getFreePort()
  const adapterPort = await getFreePort()
  const url = `http://127.0.0.1:${port}`
  const adapterUrl = `ws://127.0.0.1:${adapterPort}/adapter`
  const productPatchPath = writeProductPatch(paths, adapterPort)
  sendStatus('正在启动 AI Runtime', url)
  appendRuntimeLog(`[desktop] starting DSH Runtime at ${url}\n`)

  dshExitCode = null
  dshProcess = forkDsh([
    'web',
    '--patch', paths.patchPath,
    '--patch', productPatchPath,
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
  dshProcess.stdout?.on('data', (data) => {
    collect(data)
    collectProductRecords(data)
  })
  dshProcess.stderr?.on('data', collect)
  dshProcess.once('exit', (code) => {
    dshExitCode = code
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadFile(join(desktopRoot, 'src', 'status.html'))
      sendStatus('AI Runtime 已停止', recentLog || `退出代码 ${code}`)
    }
  })

  await waitForWeb(url, dshProcess)
  appendRuntimeLog('[desktop] DSH Web Runtime ready\n')
  runtimeWebUrl = url
  dshProductRuntime = new DshProductRuntime({
    baseUrl: url,
    cwd: app.isPackaged ? app.getPath('userData') : repoRoot,
    adapterUrl,
  })
  if (lastDshCoreSnapshot) dshProductRuntime.attachCoreSnapshot(lastDshCoreSnapshot)
  if (lastDshLearningSnapshot) dshProductRuntime.attachLearningSnapshot(lastDshLearningSnapshot)
  if (lastDshStorySnapshot) dshProductRuntime.attachStorySnapshot(lastDshStorySnapshot)
  await dshProductRuntime.start()
  appendRuntimeLog('[desktop] DSH product bridge ready\n')
  for (const record of pendingDshDiagnostics.splice(0)) dshProductRuntime.attachDiagnosticRecord(record)
  dshProductUnsubscribe = dshProductRuntime.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('platform-snapshot', snapshot)
  })
  await showHarnessPage()
}

function validateChatInput(input) {
  if (!input || typeof input !== 'object') throw new Error('对话请求格式无效。')
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message) throw new Error('请输入消息。')
  if (message.length > 8_000) throw new Error('消息过长，最多 8000 个字符。')
  return {
    message,
    sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId.slice(0, 200) : 'desktop',
    gameId: typeof input.gameId === 'string' && input.gameId ? input.gameId.slice(0, 200) : undefined,
  }
}

function requireProductRuntime() {
  const runtime = dshProductRuntime ?? platformRuntime
  if (!runtime) throw new Error('Product Runtime 尚未启动。')
  return runtime
}

function registerPlatformIpc() {
  ipcMain.handle('navigation:show-harness', () => showHarnessPage())
  ipcMain.handle('navigation:show-game', () => showGamePage())
  ipcMain.handle('platform:info', () => requireProductRuntime().info())
  ipcMain.handle('platform:snapshot', () => requireProductRuntime().snapshot())
  ipcMain.handle('platform:chat', (ipcEvent, input) => {
    const requestId = typeof input?.requestId === 'string' ? input.requestId.slice(0, 200) : ''
    return requireProductRuntime().chat(validateChatInput(input), (event) => {
      if (!ipcEvent.sender.isDestroyed()) ipcEvent.sender.send('platform-chat-event', { requestId, event })
    })
  })
  ipcMain.handle('platform:reset', (_event, input) => {
    const gameId = typeof input?.gameId === 'string' && input.gameId ? input.gameId.slice(0, 200) : undefined
    return requireProductRuntime().reset(gameId)
  })
  ipcMain.handle('platform:export-diagnostics', async () => {
    const gamePacks = (await packs().list()).map(productGamePack)
    const bundle = buildDiagnosticBundle(requireProductRuntime().snapshot(), {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      gamePacks,
    })
    const selected = await dialog.showSaveDialog(mainWindow, {
      title: '导出脱敏诊断记录',
      defaultPath: diagnosticFilename(),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (selected.canceled || !selected.filePath) return { canceled: true }
    writeFileSync(selected.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
    return { canceled: false, filePath: selected.filePath }
  })
  ipcMain.handle('platform:list-game-packs', async () => (await packs().list()).map(productGamePack))
  ipcMain.handle('platform:install-game-pack', async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择构建完成的 Game Pack 文件夹',
      properties: ['openDirectory'],
    })
    const source = selected.filePaths[0]
    if (selected.canceled || !source) return { canceled: true, gamePacks: (await packs().list()).map(productGamePack) }
    const manifest = await readGamePackManifest(source)
    const existing = await packs().get(manifest.id)
    let replace = false
    if (existing) {
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '替换已安装的 Game Pack',
        message: `${manifest.displayName} 已安装`,
        detail: `当前版本 ${existing.manifest.version}，所选版本 ${manifest.version}。替换操作只影响 Harness 的 Game Pack 副本。`,
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
      })
      if (confirmation.response !== 1) return { canceled: true, gamePacks: (await packs().list()).map(productGamePack) }
      replace = true
    }
    await packs().install(source, { replace })
    return { canceled: false, gamePacks: (await packs().list()).map(productGamePack) }
  })
  ipcMain.handle('platform:uninstall-game-pack', async (_event, input) => {
    const id = typeof input?.id === 'string' ? input.id.slice(0, 100) : ''
    const version = typeof input?.version === 'string' ? input.version.slice(0, 100) : undefined
    const installed = await packs().get(id)
    if (!installed) return { removed: false, gamePacks: (await packs().list()).map(productGamePack) }
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '卸载 Game Pack',
      message: `卸载 ${installed.manifest.displayName}？`,
      detail: '这会删除 Harness 管理的 Game Pack 副本，不会删除游戏本体或外部源文件夹。',
      buttons: ['取消', '卸载'],
      defaultId: 0,
      cancelId: 0,
    })
    if (confirmation.response !== 1) return { removed: false, gamePacks: (await packs().list()).map(productGamePack) }
    const removed = await packs().uninstall(id, version)
    return { removed, gamePacks: (await packs().list()).map(productGamePack) }
  })
}

function startDemoAdapter(adapterUrl) {
  const clientPath = join(repoRoot, 'examples', 'mock-game', 'dist', 'client.js')
  if (!existsSync(clientPath)) throw new Error(`Mock Adapter 尚未构建：${clientPath}`)
  demoAdapterProcess = utilityProcess.fork(clientPath, [], {
    cwd: repoRoot,
    env: { ...process.env, MOCK_ADAPTER_URL: adapterUrl },
    serviceName: 'AI Native Game Harness Mock Adapter',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = (data) => appendRuntimeLog(`[mock-adapter] ${data.toString()}`)
  demoAdapterProcess.stdout?.on('data', collect)
  demoAdapterProcess.stderr?.on('data', collect)
}

async function startPlatformRuntime() {
  const demo = process.env.AI_GAME_HARNESS_DEMO === '1'
  const port = Number.parseInt(process.env.AI_GAME_HARNESS_ADAPTER_PORT ?? '43145', 10)
  let createAgent
  if (demo) {
    const { MockAgentDriver } = await import('@ai-native-game-harness/mock-game/agent')
    createAgent = () => new MockAgentDriver()
  }
  platformRuntime = new PlatformRuntime({ port, createAgent })
  const info = await platformRuntime.start()
  platformUnsubscribe = platformRuntime.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('platform-snapshot', snapshot)
  })
  if (demo) startDemoAdapter(info.adapterUrl)
  await mainWindow.loadFile(join(desktopRoot, 'src', 'product.html'))
}

function createWindow() {
  const standaloneRuntime = process.env.AI_GAME_HARNESS_DEMO === '1' || process.env.AI_GAME_HARNESS_STANDALONE === '1'
  const dshRuntime = !standaloneRuntime
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: PRODUCT_TITLE,
    icon: join(desktopRoot, 'src', 'assets', 'mascot-logo.png'),
    backgroundColor: '#08131d',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(desktopRoot, 'src', 'preload.mjs'),
    },
  })
  installApplicationMenu()
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle(PRODUCT_TITLE)
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === 'ai-native-game-harness://game') {
      event.preventDefault()
      void showGamePage()
    } else if (url === 'ai-native-game-harness://harness') {
      event.preventDefault()
      void showHarnessPage()
    }
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    if (!mainWindow.webContents.getURL().startsWith('file:')) return
    event.preventDefault()
    void showHarnessPage()
  })
  const start = dshRuntime
    ? mainWindow.loadFile(join(desktopRoot, 'src', 'status.html')).then(() => startRuntime())
    : startPlatformRuntime()
  void start.catch(async (error) => {
    sendStatus('启动失败', error instanceof Error ? error.message : String(error))
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'AI Native Game Harness 游戏版启动失败',
      message: dshRuntime ? '内置 AI Runtime 未能启动。' : 'Standalone 测试 Runtime 未能启动。',
      detail: error instanceof Error ? error.message : String(error),
    })
  })
}

registerPlatformIpc()
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void (async () => {
    if (demoAdapterProcess?.pid) demoAdapterProcess.kill()
    platformUnsubscribe?.()
    await platformRuntime?.close()
    dshProductUnsubscribe?.()
    await dshProductRuntime?.close()
    if (dshProcess?.pid) dshProcess.kill()
    shutdownComplete = true
    app.quit()
  })()
})
