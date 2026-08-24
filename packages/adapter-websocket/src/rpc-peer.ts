import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import {
  ADAPTER_RPC_ERROR,
  AdapterRpcError,
  parseAdapterRpcMessage,
  type AdapterRpcFailure,
  type AdapterRpcMessage,
  type JsonObject,
  type JsonValue,
} from '@ai-native-game-harness/adapter-protocol'

interface PendingCall {
  resolve: (value: JsonValue) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RpcPeerOptions {
  requestTimeoutMs: number
  onRequest: (method: string, params: JsonObject) => Promise<JsonValue>
  onNotification: (method: string, params: JsonObject) => Promise<void> | void
  onClose?: () => void
}

export class RpcPeer {
  readonly #pending = new Map<string, PendingCall>()
  readonly #closed: Promise<void>
  #resolveClosed!: () => void
  #didClose = false

  constructor(
    readonly socket: WebSocket,
    readonly options: RpcPeerOptions,
  ) {
    this.#closed = new Promise((resolve) => { this.#resolveClosed = resolve })
    socket.on('message', (data) => { void this.#receive(data) })
    socket.on('close', () => this.#finishClose())
    socket.on('error', () => { /* close owns lifecycle and pending rejection */ })
  }

  get closed(): Promise<void> { return this.#closed }
  get isOpen(): boolean { return this.socket.readyState === WebSocket.OPEN }

  call(method: string, params: JsonObject): Promise<JsonValue> {
    if (!this.isOpen) return Promise.reject(new AdapterRpcError(ADAPTER_RPC_ERROR.adapterDisconnected, 'Adapter connection is not open'))
    const id = randomUUID()
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new AdapterRpcError(ADAPTER_RPC_ERROR.requestTimeout, `Adapter request timed out: ${method}`))
      }, this.options.requestTimeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: JsonObject): void {
    if (!this.isOpen) return
    this.#send({ jsonrpc: '2.0', method, params })
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate()
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.close(code, reason)
    else this.#finishClose()
  }

  async #receive(data: RawData): Promise<void> {
    let message: AdapterRpcMessage
    try {
      message = parseAdapterRpcMessage(data.toString())
    } catch (error) {
      const rpcError = error instanceof AdapterRpcError
        ? error
        : new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, error instanceof Error ? error.message : String(error))
      this.#sendFailure(null, rpcError)
      return
    }

    if ('method' in message) {
      if ('id' in message) {
        try {
          const result = await this.options.onRequest(message.method, message.params)
          this.#send({ jsonrpc: '2.0', id: message.id, result })
        } catch (error) {
          this.#sendFailure(message.id, this.#normalizeError(error))
        }
      } else {
        try {
          await this.options.onNotification(message.method, message.params)
        } catch {
          // Notifications intentionally have no response. Invalid notifications
          // are ignored; the next observation resynchronizes authoritative state.
        }
      }
      return
    }

    if (message.id === null) return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(message.id)
    if ('error' in message) pending.reject(new AdapterRpcError(message.error.code, message.error.message, message.error.data))
    else pending.resolve(message.result)
  }

  #normalizeError(error: unknown): AdapterRpcError {
    if (error instanceof AdapterRpcError) return error
    return new AdapterRpcError(ADAPTER_RPC_ERROR.internalError, error instanceof Error ? error.message : String(error))
  }

  #sendFailure(id: string | null, error: AdapterRpcError): void {
    const failure: AdapterRpcFailure = {
      jsonrpc: '2.0',
      id,
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    }
    this.#send(failure)
  }

  #send(message: AdapterRpcMessage): void {
    if (!this.isOpen) return
    this.socket.send(JSON.stringify(message))
  }

  #finishClose(): void {
    if (this.#didClose) return
    this.#didClose = true
    const error = new AdapterRpcError(ADAPTER_RPC_ERROR.adapterDisconnected, 'Adapter disconnected')
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.options.onClose?.()
    this.#resolveClosed()
  }
}
