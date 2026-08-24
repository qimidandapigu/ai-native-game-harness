import WebSocket from 'ws'
import {
  ADAPTER_PROTOCOL_VERSION,
  ADAPTER_RPC_ERROR,
  ADAPTER_RPC_METHOD,
  AdapterRpcError,
  assertActionRequest,
  isJsonObject,
  type AdapterConnectionState,
  type ActionRequest,
  type GameAdapter,
  type JsonObject,
  type JsonValue,
} from '@ai-native-game-harness/adapter-protocol'
import { RpcPeer } from './rpc-peer.js'

export interface ReconnectingAdapterClientOptions {
  url: string
  adapter: GameAdapter
  reconnectMinMs?: number
  reconnectMaxMs?: number
  requestTimeoutMs?: number
  onStateChange?: (state: AdapterConnectionState) => void
}

export class ReconnectingAdapterClient {
  readonly #options: Required<Omit<ReconnectingAdapterClientOptions, 'onStateChange'>> & Pick<ReconnectingAdapterClientOptions, 'onStateChange'>
  #state: AdapterConnectionState = 'disconnected'
  #controller?: AbortController
  #loop?: Promise<void>
  #peer?: RpcPeer

  constructor(options: ReconnectingAdapterClientOptions) {
    this.#options = {
      ...options,
      reconnectMinMs: options.reconnectMinMs ?? 250,
      reconnectMaxMs: options.reconnectMaxMs ?? 5_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    }
  }

  connectionState(): AdapterConnectionState { return this.#state }

  start(): void {
    if (this.#loop) return
    this.#controller = new AbortController()
    this.#loop = this.#run(this.#controller.signal).finally(() => { this.#loop = undefined })
  }

  async stop(): Promise<void> {
    this.#controller?.abort()
    this.#peer?.close(1000, 'Adapter client stopping')
    await this.#loop
    this.#controller = undefined
    this.#setState('disconnected')
  }

  async waitUntilConnected(timeoutMs = 5_000): Promise<void> {
    if (this.#state === 'connected') return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll)
        reject(new AdapterRpcError(ADAPTER_RPC_ERROR.requestTimeout, 'Timed out waiting for Adapter connection'))
      }, timeoutMs)
      const poll = setInterval(() => {
        if (this.#state !== 'connected') return
        clearTimeout(timer)
        clearInterval(poll)
        resolve()
      }, 20)
    })
  }

  async #run(signal: AbortSignal): Promise<void> {
    let delayMs = this.#options.reconnectMinMs
    while (!signal.aborted) {
      try {
        await this.#connectOnce(signal)
        delayMs = this.#options.reconnectMinMs
      } catch {
        this.#setState('disconnected')
      }
      if (signal.aborted) break
      await this.#delay(delayMs, signal)
      delayMs = Math.min(this.#options.reconnectMaxMs, Math.max(this.#options.reconnectMinMs, delayMs * 2))
    }
  }

  async #connectOnce(signal: AbortSignal): Promise<void> {
    const socket = new WebSocket(this.#options.url, { maxPayload: 1024 * 1024 })
    await this.#waitForOpen(socket, signal)
    let peer!: RpcPeer
    peer = new RpcPeer(socket, {
      requestTimeoutMs: this.#options.requestTimeoutMs,
      onRequest: async (method, params) => await this.#request(method, params),
      onNotification: () => undefined,
      onClose: () => {
        if (this.#peer === peer) this.#peer = undefined
        this.#setState('disconnected')
      },
    })
    this.#peer = peer

    try {
      const hello = await this.#options.adapter.hello()
      const acknowledged = await peer.call(ADAPTER_RPC_METHOD.hello, hello as unknown as JsonObject)
      if (!isJsonObject(acknowledged) || acknowledged.accepted !== true || acknowledged.protocolVersion !== ADAPTER_PROTOCOL_VERSION) {
        throw new AdapterRpcError(ADAPTER_RPC_ERROR.protocolVersionUnsupported, 'Adapter handshake was not accepted')
      }
    } catch (error) {
      peer.close(4003, 'Handshake rejected')
      await peer.closed
      throw error
    }
    const unsubscribe = this.#options.adapter.subscribe?.((event) => {
      peer.notify(ADAPTER_RPC_METHOD.event, event as unknown as JsonObject)
    })
    this.#setState('connected')
    try {
      await peer.closed
    } finally {
      unsubscribe?.()
      if (this.#peer === peer) this.#peer = undefined
      this.#setState('disconnected')
    }
  }

  async #request(method: string, params: JsonObject): Promise<JsonValue> {
    if (method === ADAPTER_RPC_METHOD.ping) return { pong: true }
    if (method === ADAPTER_RPC_METHOD.observe) {
      return await this.#options.adapter.observe() as unknown as JsonObject
    }
    if (method === ADAPTER_RPC_METHOD.execute) {
      const request = params as unknown as ActionRequest
      try {
        const identity = await this.#options.adapter.hello()
        assertActionRequest(request, identity.gameId)
      } catch (error) {
        throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidParams, error instanceof Error ? error.message : String(error))
      }
      return await this.#options.adapter.execute(request) as unknown as JsonObject
    }
    throw new AdapterRpcError(ADAPTER_RPC_ERROR.methodNotFound, `Unsupported Harness-to-Adapter request: ${method}`)
  }

  async #waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { socket.terminate(); reject(new Error('Adapter client stopped')) }
      const open = (): void => { cleanup(); resolve() }
      const fail = (): void => { cleanup(); reject(new AdapterRpcError(ADAPTER_RPC_ERROR.adapterDisconnected, 'Unable to connect to Adapter Host')) }
      const cleanup = (): void => {
        signal.removeEventListener('abort', abort)
        socket.off('open', open)
        socket.off('error', fail)
        socket.off('close', fail)
      }
      signal.addEventListener('abort', abort, { once: true })
      socket.once('open', open)
      socket.once('error', fail)
      socket.once('close', fail)
    })
  }

  async #delay(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
      const abort = (): void => { clearTimeout(timer); resolve() }
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  #setState(state: AdapterConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onStateChange?.(state)
  }
}
