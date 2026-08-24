import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import {
  ADAPTER_PROTOCOL_VERSION,
  ADAPTER_RPC_ERROR,
  ADAPTER_RPC_METHOD,
  AdapterRpcError,
  assertAdapterHello,
  assertGameEvent,
  isJsonObject,
  type AdapterHandshakeAck,
  type AdapterHello,
  type GameEvent,
  type JsonObject,
  type JsonValue,
} from '@ai-native-game-harness/adapter-protocol'
import { RemoteGameAdapter } from './remote-adapter.js'
import { RpcPeer } from './rpc-peer.js'

export interface WebSocketAdapterHostOptions {
  server?: HttpServer
  host?: string
  port?: number
  path?: string
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  heartbeatIntervalMs?: number
  onAdapterReady: (adapter: RemoteGameAdapter) => Promise<void> | void
}

interface IncomingConnection {
  peer: RpcPeer
  remote?: RemoteGameAdapter
  handshakeTimer: ReturnType<typeof setTimeout>
  alive: boolean
}

export class WebSocketAdapterHost {
  readonly #server: WebSocketServer
  readonly #connections = new Set<IncomingConnection>()
  readonly #adapters = new Map<string, RemoteGameAdapter>()
  readonly #options: Required<Pick<WebSocketAdapterHostOptions, 'handshakeTimeoutMs' | 'requestTimeoutMs' | 'heartbeatIntervalMs'>> & WebSocketAdapterHostOptions
  readonly #heartbeatTimer: ReturnType<typeof setInterval>

  constructor(options: WebSocketAdapterHostOptions) {
    if (!options.server && options.port === undefined) throw new Error('WebSocket Adapter Host requires an HTTP server or port')
    this.#options = {
      ...options,
      path: options.path ?? '/adapter',
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    }
    this.#server = options.server
      ? new WebSocketServer({ server: options.server, path: this.#options.path, maxPayload: 1024 * 1024 })
      : new WebSocketServer({ host: options.host ?? '127.0.0.1', port: options.port, path: this.#options.path, maxPayload: 1024 * 1024 })
    this.#server.on('connection', (socket) => this.#accept(socket))
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), this.#options.heartbeatIntervalMs)
  }

  listAdapters(): RemoteGameAdapter[] { return [...this.#adapters.values()] }

  async close(): Promise<void> {
    clearInterval(this.#heartbeatTimer)
    for (const connection of this.#connections) connection.peer.close(1001, 'Adapter Host shutting down')
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  #accept(socket: WebSocket): void {
    let connection!: IncomingConnection
    const peer = new RpcPeer(socket, {
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onRequest: async (method, params) => await this.#request(connection, method, params),
      onNotification: (method, params) => this.#notification(connection, method, params),
      onClose: () => {
        clearTimeout(connection.handshakeTimer)
        this.#connections.delete(connection)
        connection.remote?.unbind(peer)
      },
    })
    connection = {
      peer,
      handshakeTimer: setTimeout(() => peer.close(4000, 'Handshake timeout'), this.#options.handshakeTimeoutMs),
      alive: true,
    }
    socket.on('pong', () => { connection.alive = true })
    this.#connections.add(connection)
  }

  async #request(connection: IncomingConnection, method: string, params: JsonObject): Promise<JsonValue> {
    if (method !== ADAPTER_RPC_METHOD.hello) {
      if (!connection.remote) throw new AdapterRpcError(ADAPTER_RPC_ERROR.handshakeRequired, 'adapter.hello must be the first request')
      throw new AdapterRpcError(ADAPTER_RPC_ERROR.methodNotFound, `Unsupported Adapter-to-Harness request: ${method}`)
    }
    if (connection.remote) throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'adapter.hello may only be sent once per connection')
    const hello = params as unknown as AdapterHello
    try {
      assertAdapterHello(hello)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = message.startsWith('Unsupported adapter protocol')
        ? ADAPTER_RPC_ERROR.protocolVersionUnsupported
        : ADAPTER_RPC_ERROR.invalidParams
      throw new AdapterRpcError(code, message)
    }

    let remote = this.#adapters.get(hello.gameId)
    if (remote && remote.identity.adapterId !== hello.adapterId) {
      throw new AdapterRpcError(ADAPTER_RPC_ERROR.duplicateGame, `Another Adapter owns gameId: ${hello.gameId}`)
    }
    if (remote && remote.identity.adapterVersion !== hello.adapterVersion) {
      throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidParams, 'Reconnecting Adapter version changed; restart the Harness to replace it')
    }
    const firstConnection = remote === undefined
    remote ??= new RemoteGameAdapter(hello)
    connection.remote = remote
    remote.bind(connection.peer)
    clearTimeout(connection.handshakeTimer)

    if (firstConnection) {
      this.#adapters.set(hello.gameId, remote)
      try {
        await this.#options.onAdapterReady(remote)
      } catch (error) {
        this.#adapters.delete(hello.gameId)
        remote.unbind(connection.peer)
        throw error
      }
    }

    const accepted: AdapterHandshakeAck = {
      accepted: true,
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      connectionId: randomUUID(),
    }
    return accepted
  }

  #notification(connection: IncomingConnection, method: string, params: JsonObject): void {
    if (!connection.remote) {
      connection.peer.close(4002, 'Handshake required')
      return
    }
    if (method !== ADAPTER_RPC_METHOD.event) return
    if (!isJsonObject(params)) return
    const event = params as unknown as GameEvent
    assertGameEvent(event, connection.remote.identity.gameId)
    connection.remote.publish(event)
  }

  #heartbeat(): void {
    for (const connection of this.#connections) {
      if (!connection.peer.isOpen) continue
      if (!connection.alive) {
        connection.peer.socket.terminate()
        continue
      }
      connection.alive = false
      connection.peer.socket.ping()
    }
  }
}
