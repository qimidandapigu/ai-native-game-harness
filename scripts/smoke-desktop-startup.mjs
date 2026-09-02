import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptRoot, '..')
const timeoutArgument = process.argv.find(value => value.startsWith('--timeout='))
const timeoutMs = Number.parseInt(timeoutArgument?.slice('--timeout='.length) ?? '120000', 10)
const skipPrepare = process.argv.includes('--skip-prepare')
const smokeUserData = mkdtempSync(join(tmpdir(), 'agh-desktop-smoke-'))
const productionUserData = resolve(process.env.APPDATA ?? '', '@ai-native-game-harness', 'desktop')
const requireFromDesktop = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))
let desktop
let secondDesktop
let dsh
let devtools
let forcedCleanup = false

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitFor(predicate, description, timeout = timeoutMs) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`${description} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function canConnect(port) {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = value => { socket.destroy(); resolvePromise(value) }
    socket.setTimeout(300)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolvePromise(port))
    })
  })
}

function markedProcesses() {
  const escaped = smokeUserData.replaceAll("'", "''")
  const command = `$items = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${escaped}*' }; @($items | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  if (result.status !== 0 || result.stdout.trim() === '') return []
  const parsed = JSON.parse(result.stdout)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function stopMarkedProcesses() {
  const pids = markedProcesses().map(item => Number(item.ProcessId)).filter(pid => Number.isInteger(pid) && pid !== process.pid)
  for (const pid of pids.reverse()) {
    try { process.kill(pid) } catch {}
  }
  if (desktop?.pid) {
    try { process.kill(desktop.pid) } catch {}
  }
  if (secondDesktop?.pid) {
    try { process.kill(secondDesktop.pid) } catch {}
  }
  if (dsh?.pid) {
    try { process.kill(dsh.pid) } catch {}
  }
}

async function cdpEvaluate(webSocketDebuggerUrl, expression) {
  return await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP evaluation timed out')) }, 10_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    })))
    socket.addEventListener('message', event => {
      const payload = JSON.parse(String(event.data))
      if (payload.id !== 1) return
      clearTimeout(timer)
      socket.close()
      if (payload.error) reject(new Error(payload.error.message))
      else resolvePromise(payload.result?.result?.value)
    })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket failed')) })
  })
}

async function closeBrowser(webSocketDebuggerUrl) {
  await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    let sent = false
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolvePromise()
    }
    const timer = setTimeout(() => { socket.close(); finish(new Error('Browser.close timed out')) }, 10_000)
    socket.addEventListener('open', () => {
      sent = true
      socket.send(JSON.stringify({ id: 2, method: 'Browser.close' }))
    })
    socket.addEventListener('message', event => {
      const payload = JSON.parse(String(event.data))
      if (payload.id !== 2) return
      socket.close()
      finish()
    })
    socket.addEventListener('close', () => sent ? finish() : finish(new Error('Browser.close websocket closed before sending')))
    socket.addEventListener('error', () => sent ? finish() : finish(new Error('Browser.close websocket failed')))
  })
}

try {
  if (resolve(smokeUserData).toLowerCase() === productionUserData.toLowerCase()) {
    throw new Error('smoke profile unexpectedly equals the production profile')
  }
  if (await canConnect(33145)) throw new Error('port 33145 is already in use; close the running Desktop before the isolated smoke test')

  if (!skipPrepare) {
    const prepared = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'prepare-desktop-dev.ps1'),
    ], { cwd: repoRoot, stdio: 'inherit', env: process.env })
    if (prepared.status !== 0) throw new Error(`desktop development preparation failed with exit code ${prepared.status}`)
  }

  const preparedUserData = join(repoRoot, '.artifacts', 'desktop-dev-user-data')
  const preparedDshHome = join(preparedUserData, 'dsh-home')
  const preparedRuntimeState = join(preparedUserData, 'runtime-state')
  if (!existsSync(preparedDshHome) || !existsSync(preparedRuntimeState)) {
    throw new Error('prepared Desktop development profile is missing; run without --skip-prepare once')
  }
  cpSync(preparedDshHome, join(smokeUserData, 'dsh-home'), {
    recursive: true,
    filter(source) {
      const segments = relative(preparedDshHome, source).split(sep)
      if (segments[0] === 'storages') return false
      return !(segments[0] === 'profiles' && segments[1] === 'node_modules')
    },
  })
  cpSync(preparedRuntimeState, join(smokeUserData, 'runtime-state'), { recursive: true })

  const electronPackage = requireFromDesktop.resolve('electron/package.json')
  const packagedElectron = join(dirname(electronPackage), 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const electronExecutable = resolve(process.env.AI_GAME_HARNESS_ELECTRON ?? packagedElectron)
  if (!existsSync(electronExecutable)) {
    throw new Error(`Electron executable not found: ${electronExecutable}. Set AI_GAME_HARNESS_ELECTRON to a verified Electron ${JSON.parse(readFileSync(electronPackage, 'utf8')).version} executable.`)
  }
  const dshPackage = requireFromDesktop.resolve('@deepseek-ai/dsh/package.json')
  const dshBin = join(dirname(dshPackage), 'lib', 'bin.js')
  const runtimePort = await freePort()
  const smokePatch = join(smokeUserData, 'desktop-smoke.patch.yml')
  writeFileSync(smokePatch, `- id: xiaotangyuan-game\n  config:\n    port: 33145\n    vision:\n      enabled: false\n    speech:\n      enabled: false\n    media:\n      enabled: false\n    proactiveChat:\n      enabled: false\n    memory:\n      directory: '${join(smokeUserData, 'memory').replaceAll("'", "''")}'\n- id: work-orchestrator\n  config:\n    enabled: false\n`, 'utf8')
  let dshOutput = ''
  dsh = spawn(process.execPath, [
    '--expose-internals', dshBin, 'web',
    '--patch', join(repoRoot, 'integrations', 'xiaotangyuan', 'desktop.patch.yml'),
    '--patch', smokePatch,
    '--no-open', '--host', '127.0.0.1', '--port', String(runtimePort),
  ], {
    cwd: smokeUserData,
    env: {
      ...process.env,
      DSH_HOME: join(smokeUserData, 'dsh-home'),
      LOCALAPPDATA: join(smokeUserData, 'local-app-data'),
      APPDATA: join(smokeUserData, 'roaming-app-data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const collectDshOutput = data => {
    const text = data.toString()
    dshOutput = `${dshOutput}${text}`.slice(-20_000)
    if (process.env.AI_GAME_HARNESS_SMOKE_DEBUG === '1') process.stderr.write(text)
  }
  dsh.stdout.on('data', collectDshOutput)
  dsh.stderr.on('data', collectDshOutput)
  await waitFor(async () => {
    if (dsh.exitCode !== null || dsh.signalCode !== null) throw new Error(`DSH exited before readiness.\n${dshOutput}`)
    return await canConnect(runtimePort)
  }, 'DSH Web listener')
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`
  await waitFor(async () => (await fetch(runtimeUrl)).ok, 'DSH Web HTTP response')
  await waitFor(() => canConnect(33145), 'XiaoTangYuan gateway port 33145')

  const debugPort = await freePort()
  let output = ''
  const desktopEnvironment = {
    ...process.env,
    AI_GAME_HARNESS_DEV: '1',
    AI_GAME_HARNESS_DEV_USER_DATA: smokeUserData,
    AI_GAME_HARNESS_STANDALONE: '1',
    LOCALAPPDATA: join(smokeUserData, 'local-app-data'),
    APPDATA: join(smokeUserData, 'roaming-app-data'),
  }
  desktop = spawn(electronExecutable, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: join(repoRoot, 'apps', 'desktop'),
    env: desktopEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const collectDesktopOutput = data => {
    const text = data.toString()
    output = `${output}${text}`.slice(-20_000)
    if (process.env.AI_GAME_HARNESS_SMOKE_DEBUG === '1') process.stderr.write(text)
  }
  desktop.stdout.on('data', collectDesktopOutput)
  desktop.stderr.on('data', collectDesktopOutput)

  await waitFor(async () => {
    if (desktop.exitCode !== null || desktop.signalCode !== null) throw new Error(`Desktop exited before preload readiness.\n${output}`)
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    if (!response.ok) return false
    const pages = await response.json()
    return pages.find(page => page.type === 'page' && page.url?.includes('/product.html') && page.webSocketDebuggerUrl)
  }, 'Electron DevTools page').then(page => { devtools = page.webSocketDebuggerUrl })

  const preloadProbe = await cdpEvaluate(devtools, `({
    ready: Boolean(window.harnessDesktop && window.harnessDesktop.platform && typeof window.harnessDesktop.platform.info === 'function'),
    harnessDesktopType: typeof window.harnessDesktop,
    url: location.href,
    title: document.title
  })`)
  if (preloadProbe?.ready !== true) throw new Error(`preload did not expose window.harnessDesktop.platform: ${JSON.stringify(preloadProbe)}`)
  if (!existsSync(join(smokeUserData, 'dsh-home'))) throw new Error('isolated development DSH_HOME was not created')

  secondDesktop = spawn(electronExecutable, ['.'], {
    cwd: join(repoRoot, 'apps', 'desktop'),
    env: desktopEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  await waitFor(() => secondDesktop.exitCode !== null || secondDesktop.signalCode !== null, 'second Desktop single-instance exit', 10_000)
  if (desktop.exitCode !== null || desktop.signalCode !== null) throw new Error('primary Desktop exited when the second instance was launched')

  await closeBrowser(devtools)
  await waitFor(() => desktop.exitCode !== null || desktop.signalCode !== null, 'Desktop graceful exit', 30_000)
  dsh.kill('SIGTERM')
  await waitFor(() => dsh.exitCode !== null || dsh.signalCode !== null, 'DSH graceful exit', 30_000)
  await waitFor(() => markedProcesses().length === 0, 'Desktop and DSH child process cleanup', 30_000)
  await waitFor(async () => !(await canConnect(33145)), 'gateway port cleanup', 30_000)

  console.log(JSON.stringify({
    ok: true,
    preload: 'loaded',
    desktopMode: 'standalone-shell',
    singleInstance: true,
    dshWeb: runtimeUrl,
    gatewayPort: 33145,
    profile: smokeUserData,
    productionProfile: productionUserData,
    isolated: true,
    residualProcesses: 0,
  }, null, 2))
} catch (error) {
  forcedCleanup = true
  stopMarkedProcesses()
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  if (forcedCleanup) {
    await sleep(1000)
    stopMarkedProcesses()
  }
  if (markedProcesses().length === 0) rmSync(smokeUserData, { recursive: true, force: true })
}
