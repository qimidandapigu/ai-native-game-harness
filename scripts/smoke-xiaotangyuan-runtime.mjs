import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
  args.set(key.slice(2), value)
}

const required = (name) => {
  const value = args.get(name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

const repoRoot = resolve(required('repo-root'))
const dshBin = resolve(required('dsh-bin'))
const dshHome = resolve(required('dsh-home'))
const profile = required('profile')
const patchPath = resolve(required('patch'))
const configuredGatewayPort = Number(required('gateway-port'))
const timeoutMs = Number(args.get('timeout-ms') ?? '60000')

if (!Number.isInteger(configuredGatewayPort) || configuredGatewayPort < 0 || configuredGatewayPort > 65535) {
  throw new Error(`invalid Gateway port: ${configuredGatewayPort}`)
}

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))

function listen(server, port = 0) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen)
      const address = server.address()
      if (typeof address !== 'object' || address === null) rejectListen(new Error('server did not expose a TCP address'))
      else resolveListen(address.port)
    })
  })
}

async function reserveFreePort() {
  const server = createTcpServer()
  const port = await listen(server)
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
  return port
}

async function assertPortAvailable(port) {
  const server = createTcpServer()
  try {
    await listen(server, port)
  } catch (error) {
    throw new Error(`Gateway port ${port} is already in use; close the running Harness instance before integration:xiaotangyuan`, { cause: error })
  } finally {
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
  }
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolveClose => {
    server.close(() => resolveClose())
    server.closeAllConnections?.()
  })
}

function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolveStop => {
    const forced = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5000)
    child.once('exit', () => {
      clearTimeout(forced)
      resolveStop()
    })
    child.kill('SIGTERM')
  })
}

async function waitForWeb(url, child, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited before the Web page became ready with code ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error(`timed out waiting for Web page ${url}`)
}

function connectGateway(url, deadline) {
  return new Promise((resolveConnect, rejectConnect) => {
    let timer
    const attempt = () => {
      if (Date.now() >= deadline) {
        rejectConnect(new Error(`timed out waiting for Gateway ${url}`))
        return
      }
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolveConnect(socket)
      }, { once: true })
      socket.addEventListener('error', () => {
        socket.close()
        timer = setTimeout(attempt, 250)
      }, { once: true })
    }
    attempt()
  })
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise(resolveClose => {
    socket.addEventListener('close', () => resolveClose(), { once: true })
    socket.close(1000, 'runtime smoke reconnect')
  })
}

function rpcClient(socket) {
  let sequence = 0
  const pending = new Map()

  socket.addEventListener('message', event => {
    let payload
    try { payload = JSON.parse(String(event.data)) } catch { return }
    if (payload.id === undefined) return
    const request = pending.get(String(payload.id))
    if (request === undefined) return
    pending.delete(String(payload.id))
    clearTimeout(request.timer)
    if (payload.error !== undefined) request.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)))
    else request.resolve(payload.result)
  })

  const request = (method, params, requestTimeoutMs = 30000) => new Promise((resolveRequest, rejectRequest) => {
    const id = `smoke-${++sequence}`
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectRequest(new Error(`timed out waiting for ${method}`))
    }, requestTimeoutMs)
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })

  return { request }
}

function mockCompletionServer() {
  let requests = 0
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke-vision', object: 'model' }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    requests += 1
    request.resume()
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'close',
      })
      const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
        id: 'smoke-completion',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'smoke-vision',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      chunk({ content: '小汤圆桌面运行时冒烟测试通过。' })
      chunk({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  return { server, requestCount: () => requests }
}

let dshProcess
const mock = mockCompletionServer()
let runtimeLog = ''

try {
  const gatewayPort = configuredGatewayPort === 0 ? await reserveFreePort() : configuredGatewayPort
  await assertPortAvailable(gatewayPort)
  const webPort = await reserveFreePort()
  const modelPort = await listen(mock.server)
  await mkdir(dshHome, { recursive: true })
  const runtimePatchPath = resolve(dshHome, 'xiaotangyuan-runtime-smoke.patch.yml')
  await writeFile(runtimePatchPath, `- id: xiaotangyuan-game\n  config:\n    port: ${gatewayPort}\n- id: xiaotangyuan-oni-adapter\n  config:\n    port: ${gatewayPort}\n`, 'utf8')
  const settingsPath = resolve(dshHome, 'settings.yaml')
  const settings = `llm-pi-ai:\n  providers:\n    smoke-local:\n      displayName: Local Smoke Model\n      apiKeyEnv: XIAOTANGYUAN_SMOKE_API_KEY\n      api: openai-completions\n      baseURL: http://127.0.0.1:${modelPort}/v1\n      models:\n        - id: smoke-vision\n          name: Smoke Vision\n          contextWindow: 32768\n          maxTokens: 1024\n          input:\n            - text\n            - image\nagent-default-model:\n  provider: smoke-local\n  model: smoke-vision\n`
  await writeFile(settingsPath, settings, 'utf8')

  dshProcess = spawn(process.execPath, [
    dshBin,
    '--profile', profile,
    '--patch', patchPath,
    '--patch', runtimePatchPath,
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(webPort),
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_DISABLE_HMR: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      XIAOTANGYUAN_SMOKE_API_KEY: 'local-smoke-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const collect = data => { runtimeLog = `${runtimeLog}${data.toString()}`.slice(-16000) }
  dshProcess.stdout.on('data', collect)
  dshProcess.stderr.on('data', collect)

  const deadline = Date.now() + timeoutMs
  const webUrl = `http://127.0.0.1:${webPort}`
  await waitForWeb(webUrl, dshProcess, deadline)
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`
  const socket = await connectGateway(gatewayUrl, deadline)
  const rpc = rpcClient(socket)
  let resumedSocket
  try {
    const hello = await rpc.request('adapter.hello', {
      adapterId: 'ai-native-game-harness.runtime-smoke',
      gameId: 'runtime-smoke',
      version: '1.0.0',
      protocolVersion: '1.1',
      capabilities: ['assistant.text-stream'],
      saveId: 'runtime-smoke-save',
    })
    if (hello?.accepted !== true) throw new Error(`adapter.hello was not accepted: ${JSON.stringify(hello)}`)

    const state = await rpc.request('state.update', {
      saveId: 'runtime-smoke-save',
      observation: {
        schema: 'ai-native.game-context.v1',
        meta: { gameId: 'runtime-smoke', capturedAt: new Date().toISOString() },
        scene: { location: { id: 'smoke-room' } },
        player: { name: 'Smoke Player' },
        entities: [],
        objectives: [],
        ui: {},
      },
    })
    if (state?.accepted !== true) throw new Error(`state.update was not accepted: ${JSON.stringify(state)}`)

    const chat = await rpc.request('chat.send', {
      text: '请确认桌面运行时冒烟测试。',
      context: { saveId: 'runtime-smoke-save' },
    }, Math.max(30000, timeoutMs))
    if (chat?.reply !== '小汤圆桌面运行时冒烟测试通过。') {
      throw new Error(`unexpected chat reply: ${JSON.stringify(chat)}`)
    }
    if (typeof chat?.sessionId !== 'string' || chat.sessionId === '') {
      throw new Error(`first chat did not return a sessionId: ${JSON.stringify(chat)}`)
    }

    await closeSocket(socket)
    resumedSocket = await connectGateway(gatewayUrl, deadline)
    const resumedRpc = rpcClient(resumedSocket)
    const resumedHello = await resumedRpc.request('adapter.hello', {
      adapterId: 'ai-native-game-harness.runtime-smoke',
      gameId: 'runtime-smoke',
      version: '1.0.0',
      protocolVersion: '1.1',
      capabilities: ['assistant.text-stream'],
      saveId: 'runtime-smoke-save',
    })
    if (resumedHello?.accepted !== true) throw new Error(`resumed adapter.hello was not accepted: ${JSON.stringify(resumedHello)}`)
    const resumedChat = await resumedRpc.request('chat.send', {
      text: '重新进入游戏后，请再次确认桌面运行时冒烟测试。',
      context: { saveId: 'runtime-smoke-save' },
    }, Math.max(30000, timeoutMs))
    if (resumedChat?.reply !== '小汤圆桌面运行时冒烟测试通过。') {
      throw new Error(`unexpected resumed chat reply: ${JSON.stringify(resumedChat)}`)
    }
    if (resumedChat.sessionId !== chat.sessionId) {
      throw new Error(`game chat session was not resumed: ${chat.sessionId} -> ${resumedChat.sessionId}`)
    }
    if (mock.requestCount() < 2) throw new Error('the local smoke model did not receive both chat requests')

    console.log(JSON.stringify({
      web: webUrl,
      gateway: gatewayUrl,
      adapter: true,
      state: true,
      chat: true,
      chatResumed: true,
      sessionId: chat.sessionId,
      localModelRequests: mock.requestCount(),
    }))
  } finally {
    socket.close()
    resumedSocket?.close()
  }
} catch (error) {
  if (runtimeLog !== '') console.error(`--- DSH runtime log ---\n${runtimeLog}`)
  throw error
} finally {
  await stopProcess(dshProcess)
  await closeServer(mock.server)
}
