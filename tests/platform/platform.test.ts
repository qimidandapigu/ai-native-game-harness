import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import {
  ADAPTER_RPC_ERROR,
  ADAPTER_RPC_METHOD,
  assertAdapterHello,
  type AdapterRpcFailure,
  type GameAdapter,
  type GameEvent,
} from '@ai-native-game-harness/adapter-protocol'
import { ReconnectingAdapterClient, WebSocketAdapterHost } from '@ai-native-game-harness/adapter-websocket'
import { assertGamePackManifest } from '@ai-native-game-harness/game-pack'
import {
  HarnessCore,
  type AgentActionFeedback,
  type AgentDriver,
  type AgentEvent,
  type AgentRequest,
} from '@ai-native-game-harness/harness-core'
import { MockAgentDriver } from '@ai-native-game-harness/mock-game/agent'
import { MockGameAdapter } from '@ai-native-game-harness/mock-game/adapter'
// Desktop runtime is intentionally plain ESM so Electron can load it without a second bundle step.
// @ts-expect-error JavaScript entry points do not publish declarations.
import { PlatformRuntime } from '../../apps/desktop/src/platform-runtime.mjs'

describe('independent platform boundary', () => {
  it('rejects an Adapter with an unsupported protocol version', () => {
    expect(() => assertAdapterHello({
      protocolVersion: '2.0',
      adapterId: 'demo.adapter',
      gameId: 'demo-game',
      displayName: 'Demo',
      adapterVersion: '1.0.0',
      capabilities: [],
    } as never)).toThrow(/Unsupported adapter protocol/)
  })

  it('runs state to agent to action to authoritative state without DSH', async () => {
    const core = new HarnessCore()
    const adapter: GameAdapter = new MockGameAdapter()
    await core.connectAdapter(adapter)
    const events = []
    for await (const event of core.chat(new MockAgentDriver(), {
      sessionId: 'test-session',
      gameId: 'mock-game',
      message: '帮我去捡金币',
    })) events.push(event)

    const state = (await core.observe('mock-game')).state
    expect(events.some((event) => event.type === 'action' && event.capability === 'game.collect')).toBe(true)
    expect(events.some((event) => event.type === 'action-result' && event.capability === 'game.collect' && event.result.ok)).toBe(true)
    expect(state.player).toMatchObject({ x: 2, y: 1, energy: 9, coins: 1 })
    expect(state.coin).toMatchObject({ collected: true })
    expect(core.listTraces().some((trace) => trace.kind === 'action.executed')).toBe(true)
    await core.close()
  })

  it('hosts the Desktop Core and remote Adapter as one independent runtime', async () => {
    const runtime = new PlatformRuntime({
      port: 0,
      createAgent: () => new MockAgentDriver(),
    })
    const info = await runtime.start()
    const client = new ReconnectingAdapterClient({
      url: info.adapterUrl,
      adapter: new MockGameAdapter(),
      reconnectMinMs: 30,
      reconnectMaxMs: 60,
      requestTimeoutMs: 2_000,
    })
    client.start()

    try {
      await client.waitUntilConnected(3_000)
      const result = await runtime.chat({ sessionId: 'desktop-test', message: '帮我去捡金币' })
      expect(result.events.some((event: { type: string; capability?: string }) => event.type === 'action' && event.capability === 'game.collect')).toBe(true)
      expect(result.snapshot.observations[0]?.state.player).toMatchObject({ x: 2, y: 1, coins: 1 })

      const reset = await runtime.reset('mock-game')
      expect(reset.observations[0]?.state.player).toMatchObject({ x: 0, y: 0, coins: 0 })
    } finally {
      await client.stop()
      await runtime.close()
    }
  })

  it('rejects an undeclared Agent action in Core and returns the failure to the Driver', async () => {
    const core = new HarnessCore()
    await core.connectAdapter(new MockGameAdapter())
    let received: AgentActionFeedback | undefined
    const driver: AgentDriver = {
      async *stream(_request: AgentRequest): AsyncGenerator<AgentEvent, void, AgentActionFeedback> {
        received = yield { type: 'action', callId: 'unsafe-action', capability: 'game.delete-save', arguments: {} }
        yield { type: 'done', text: received.result.ok ? 'unexpected' : received.result.error?.code ?? 'missing error' }
      },
    }

    try {
      const events = []
      for await (const event of core.chat(driver, {
        sessionId: 'rejected-action-test',
        gameId: 'mock-game',
        message: '删除存档',
      })) events.push(event)

      expect(received).toMatchObject({
        callId: 'unsafe-action',
        capability: 'game.delete-save',
        result: { requestId: 'unsafe-action', ok: false, error: { code: 'HARNESS_ACTION_REJECTED' } },
      })
      expect(events.some((event) => event.type === 'action-result' && !event.result.ok)).toBe(true)
      expect((await core.observe('mock-game')).state.player).toMatchObject({ x: 0, y: 0, coins: 0 })
    } finally {
      await core.close()
    }
  })

  it('stops an Agent that exceeds the configured action limit', async () => {
    const core = new HarnessCore()
    await core.connectAdapter(new MockGameAdapter())
    const driver: AgentDriver = {
      async *stream(_request: AgentRequest): AsyncGenerator<AgentEvent, void, AgentActionFeedback> {
        while (true) yield { type: 'action', capability: 'game.reset', arguments: {} }
      },
    }
    const run = async () => {
      for await (const _event of core.chat(driver, {
        sessionId: 'action-limit-test',
        gameId: 'mock-game',
        message: '不停重置',
      }, { maxActions: 2 })) { /* consume */ }
    }

    try {
      await expect(run()).rejects.toThrow('Agent action limit exceeded: 2')
      expect(core.listTraces().filter((trace) => trace.kind === 'action.executed')).toHaveLength(2)
    } finally {
      await core.close()
    }
  })

  it('rejects Game Pack files that escape the pack root', () => {
    expect(() => assertGamePackManifest({
      schemaVersion: 1,
      id: 'unsafe-pack',
      version: '1.0.0',
      displayName: 'Unsafe Pack',
      adapter: { id: 'unsafe.adapter', entry: '../outside.js', protocolVersion: '1.0' },
      content: {},
    })).toThrow(/cannot leave the pack root/)
  })

  it('runs remote observe, action, events and reconnect over WebSocket', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server has no TCP port')

    const core = new HarnessCore()
    const host = new WebSocketAdapterHost({
      server,
      path: '/adapter',
      requestTimeoutMs: 2_000,
      onAdapterReady: async (adapter) => { await core.connectAdapter(adapter) },
    })
    const client = new ReconnectingAdapterClient({
      url: `ws://127.0.0.1:${address.port}/adapter`,
      adapter: new MockGameAdapter(),
      reconnectMinMs: 30,
      reconnectMaxMs: 60,
      requestTimeoutMs: 2_000,
    })
    client.start()

    try {
      await client.waitUntilConnected(3_000)
      await waitFor(() => core.listAdapters()[0]?.status === 'connected')
      const remote = host.listAdapters()[0]
      if (!remote) throw new Error('Remote Adapter was not registered')
      const events: GameEvent[] = []
      const states: string[] = []
      const unsubscribeEvent = remote.subscribe((event) => events.push(event))
      const unsubscribeState = remote.subscribeConnection((state) => states.push(state))

      const before = await core.observe('mock-game')
      const moved = await core.executeAction('mock-game', 'game.move', { x: 2, y: 1 }, { expectedRevision: before.revision })
      expect(moved).toMatchObject({ ok: true, revision: 1 })
      expect(events.some((event) => event.type === 'player.moved')).toBe(true)

      await remote.close()
      await waitFor(() => states.includes('disconnected'))
      await waitFor(() => states.lastIndexOf('connected') > states.lastIndexOf('disconnected'), 4_000)
      expect(core.listAdapters()[0]?.status).toBe('connected')
      expect(await core.observe('mock-game')).toMatchObject({ revision: 1 })

      unsubscribeEvent()
      unsubscribeState()
    } finally {
      await client.stop()
      await core.close()
      await host.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns stable protocol error codes before or during handshake', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server has no TCP port')
    const host = new WebSocketAdapterHost({ server, path: '/adapter', onAdapterReady: () => undefined })

    try {
      const socket = await openSocket(`ws://127.0.0.1:${address.port}/adapter`)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'observe-first', method: ADAPTER_RPC_METHOD.observe, params: {} }))
      const handshakeRequired = await nextJson(socket) as AdapterRpcFailure
      expect(handshakeRequired.error.code).toBe(ADAPTER_RPC_ERROR.handshakeRequired)

      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'bad-version',
        method: ADAPTER_RPC_METHOD.hello,
        params: {
          protocolVersion: '9.0',
          adapterId: 'bad.adapter',
          gameId: 'bad-game',
          displayName: 'Bad Adapter',
          adapterVersion: '1.0.0',
          capabilities: [],
        },
      }))
      const unsupported = await nextJson(socket) as AdapterRpcFailure
      expect(unsupported.error.code).toBe(ADAPTER_RPC_ERROR.protocolVersionUnsupported)
      socket.close()
    } finally {
      await host.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function nextJson(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) }
    })
    socket.once('error', reject)
  })
}
