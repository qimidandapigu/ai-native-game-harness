import {
  ADAPTER_RPC_ERROR,
  ADAPTER_RPC_METHOD,
  AdapterRpcError,
  assertActionResult,
  assertGameEvent,
  assertObservation,
  isJsonObject,
  type ActionRequest,
  type ActionResult,
  type AdapterConnectionState,
  type AdapterHello,
  type GameAdapter,
  type GameEvent,
  type GameObservation,
  type JsonObject,
} from '@ai-native-game-harness/adapter-protocol'
import { RpcPeer } from './rpc-peer.js'

export class RemoteGameAdapter implements GameAdapter {
  readonly #eventListeners = new Set<(event: GameEvent) => void>()
  readonly #connectionListeners = new Set<(state: AdapterConnectionState) => void>()
  #peer?: RpcPeer
  #state: AdapterConnectionState = 'disconnected'

  constructor(readonly identity: AdapterHello) {}

  async hello(): Promise<AdapterHello> { return this.identity }
  connectionState(): AdapterConnectionState { return this.#state }

  async observe(): Promise<GameObservation> {
    const result = await this.#call(ADAPTER_RPC_METHOD.observe, {})
    if (!isJsonObject(result)) throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'game.observe result must be an object')
    const observation = result as unknown as GameObservation
    assertObservation(observation, this.identity.gameId)
    return observation
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const result = await this.#call(ADAPTER_RPC_METHOD.execute, request as unknown as JsonObject)
    if (!isJsonObject(result)) throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'game.execute result must be an object')
    const actionResult = result as unknown as ActionResult
    assertActionResult(request, actionResult)
    return actionResult
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  subscribeConnection(listener: (state: AdapterConnectionState) => void): () => void {
    this.#connectionListeners.add(listener)
    return () => this.#connectionListeners.delete(listener)
  }

  async close(): Promise<void> {
    this.#peer?.close(1000, 'Harness shutting down')
    this.#peer = undefined
    this.#setState('disconnected')
  }

  bind(peer: RpcPeer): void {
    const previous = this.#peer
    this.#peer = peer
    this.#setState('connected')
    if (previous && previous !== peer) previous.close(4001, 'Replaced by reconnect')
  }

  unbind(peer: RpcPeer): void {
    if (this.#peer !== peer) return
    this.#peer = undefined
    this.#setState('disconnected')
  }

  publish(event: GameEvent): void {
    assertGameEvent(event, this.identity.gameId)
    for (const listener of this.#eventListeners) listener(event)
  }

  async #call(method: string, params: JsonObject): Promise<unknown> {
    const peer = this.#peer
    if (!peer?.isOpen) throw new AdapterRpcError(ADAPTER_RPC_ERROR.adapterDisconnected, `Adapter is disconnected: ${this.identity.gameId}`)
    return await peer.call(method, params)
  }

  #setState(state: AdapterConnectionState): void {
    if (this.#state === state) return
    this.#state = state
    for (const listener of this.#connectionListeners) listener(state)
  }
}
