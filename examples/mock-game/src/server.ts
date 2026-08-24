import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fork, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketAdapterHost } from '@ai-native-game-harness/adapter-websocket'
import { HarnessCore } from '@ai-native-game-harness/harness-core'
import { MockAgentDriver } from './agent.js'

const core = new HarnessCore()
const agent = new MockAgentDriver()
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const uiRoot = join(root, 'apps', 'desktop', 'src')
const port = Number(process.env.PORT ?? 4173)

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true })
    if (request.method === 'GET' && url.pathname === '/api/snapshot') return json(response, 200, core.snapshot())
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const input = await body(request)
      const events = []
      for await (const event of core.chat(agent, {
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : 'desktop-demo',
        gameId: 'mock-game',
        message: typeof input.message === 'string' ? input.message : '',
      })) events.push(event)
      return json(response, 200, { events, snapshot: core.snapshot() })
    }
    if (request.method === 'POST' && url.pathname === '/api/reset') {
      const adapter = adapterHost.listAdapters().find((item) => item.identity.gameId === 'mock-game')
      if (!adapter || adapter.connectionState() !== 'connected') return json(response, 409, { error: 'Mock Adapter is disconnected' })
      await core.executeAction('mock-game', 'game.reset', {})
      return json(response, 200, core.snapshot())
    }

    const requested = url.pathname === '/' ? 'product.html' : url.pathname.slice(1)
    if (!['product.html', 'product.css', 'product.js'].includes(requested)) return json(response, 404, { error: 'Not found' })
    const file = join(uiRoot, requested)
    const content = await readFile(file)
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    response.end(content)
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

const adapterHost = new WebSocketAdapterHost({
  server,
  path: '/adapter',
  onAdapterReady: async (adapter) => { await core.connectAdapter(adapter) },
})

let adapterProcess: ChildProcess | undefined

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Native Game Harness Mock UI: http://127.0.0.1:${port}`)
  if (process.env.MOCK_ADAPTER_AUTOSTART !== '0') {
    adapterProcess = fork(join(dirname(fileURLToPath(import.meta.url)), 'client.js'), [], {
      env: { ...process.env, MOCK_ADAPTER_URL: `ws://127.0.0.1:${port}/adapter` },
      stdio: 'inherit',
    })
  }
})

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  adapterProcess?.kill()
  await core.close()
  await adapterHost.close()
  server.close(() => process.exit(0))
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void stop() })
}
