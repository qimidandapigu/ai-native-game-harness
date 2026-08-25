import { createServer } from 'node:http'
import { WebSocketAdapterHost } from '@ai-native-game-harness/adapter-websocket'
import { HarnessCore } from '@ai-native-game-harness/harness-core'

class UnavailableAgentDriver {
  async *stream() {
    const text = '游戏已经连接，但还没有配置 Agent Driver。请使用 Demo 模式验证流程，或接入你自己的 Agent 实现。'
    yield { type: 'analysis', text: 'Adapter 与游戏状态正常；当前缺少负责决策的 Agent Driver。' }
    yield { type: 'done', text }
  }
}

export class PlatformRuntime {
  #core
  #agent
  #httpServer
  #adapterHost
  #address

  constructor({ host = '127.0.0.1', port = 43145, path = '/adapter', createAgent } = {}) {
    this.host = host
    this.port = port
    this.path = path
    this.#core = new HarnessCore()
    this.#agent = createAgent?.() ?? new UnavailableAgentDriver()
  }

  async start() {
    if (this.#address) return this.#address
    this.#httpServer = createServer((request, response) => {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'Adapter WebSocket endpoint only' }))
    })
    this.#adapterHost = new WebSocketAdapterHost({
      server: this.#httpServer,
      path: this.path,
      onAdapterReady: async (adapter) => await this.#core.connectAdapter(adapter),
    })
    try {
      await new Promise((resolve, reject) => {
        this.#httpServer.once('error', reject)
        this.#httpServer.listen(this.port, this.host, resolve)
      })
    } catch (error) {
      await this.#adapterHost.close()
      throw error
    }
    const address = this.#httpServer.address()
    const port = typeof address === 'object' && address ? address.port : this.port
    this.#address = {
      host: this.host,
      port,
      adapterUrl: `ws://${this.host}:${port}${this.path}`,
    }
    return this.#address
  }

  info() {
    if (!this.#address) throw new Error('Platform Runtime is not running')
    return this.#address
  }

  snapshot() {
    return {
      ...this.#core.snapshot(),
      runtime: {
        kind: 'standalone',
        label: 'Standalone Agent',
        status: this.#address ? 'online' : 'offline',
        sessionId: 'desktop',
        agentRunning: false,
        reconnectCount: 0,
        adapterUrl: this.#address?.adapterUrl,
        hiddenReasoning: 'not-exposed',
        directActions: true,
      },
    }
  }

  subscribe(listener) {
    return this.#core.subscribe(listener)
  }

  async chat({ sessionId = 'desktop', gameId, message }, onEvent = () => undefined) {
    const selectedGameId = gameId ?? this.#core.listAdapters().find((adapter) => adapter.status === 'connected')?.gameId
    if (!selectedGameId) throw new Error('还没有游戏 Adapter 连接到 Harness。')
    const events = []
    for await (const event of this.#core.chat(this.#agent, {
      sessionId,
      gameId: selectedGameId,
      message,
    })) {
      // Analysis is an Agent-private signal, not a product-page payload.
      if (event.type === 'analysis') continue
      events.push(event)
      onEvent(event)
    }
    return { events, snapshot: this.snapshot() }
  }

  async reset(gameId) {
    const selected = gameId
      ? this.#core.listAdapters().find((adapter) => adapter.gameId === gameId)
      : this.#core.listAdapters().find((adapter) => adapter.status === 'connected')
    if (!selected) throw new Error('还没有游戏 Adapter 连接到 Harness。')
    const resetCapability = selected.capabilities.find((capability) => capability.kind === 'action' && capability.name === 'game.reset')
    if (!resetCapability) throw new Error(`${selected.displayName} 没有声明 game.reset 能力。`)
    await this.#core.executeAction(selected.gameId, resetCapability.name, {}, { sessionId: 'desktop-reset' })
    return this.snapshot()
  }

  async close() {
    await this.#core.close()
    await this.#adapterHost?.close()
    if (this.#httpServer?.listening) {
      await new Promise((resolve) => this.#httpServer.close(resolve))
    }
    this.#address = undefined
  }
}
