import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEventListener,
  type BridgeHello,
  type GameObservation,
  type JsonObject,
  type JsonValue,
  type NativeBridge,
} from '@ai-native-game-harness/bridge-contract'

export interface FakeGameState extends JsonObject {
  player: {
    x: number
    y: number
    energy: number
    coins: number
  }
  coin: {
    x: number
    y: number
    collected: boolean
  }
}
export class FakeNativeBridge implements NativeBridge {
  private readonly listeners = new Set<BridgeEventListener>()
  private revision = 0
  private closed = false
  private state: FakeGameState = {
    player: { x: 0, y: 0, energy: 10, coins: 0 },
    coin: { x: 2, y: 1, collected: false },
  }

  hello(): BridgeHello {
    return {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      bridgeId: 'ai-native.fake-game.bridge',
      bridgeVersion: '0.1.0',
      gameId: 'fake-game',
      gameVersion: '1.0.0',
      capabilities: ['game.observe', 'game.move', 'game.collect'],
    }
  }

  async request(method: string, params: JsonObject, signal: AbortSignal): Promise<JsonValue> {
    if (this.closed) throw new Error('fake native bridge is closed')
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('bridge request aborted')
    switch (method) {
      case 'game.observe':
        return this.observe()
      case 'game.move':
        return this.move(params)
      case 'game.collect':
        return this.collect()
      default:
        throw new Error(`unsupported fake game API: ${method}`)
    }
  }

  subscribe(listener: BridgeEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
  }

  snapshot(): GameObservation<FakeGameState> {
    return this.observe()
  }

  private observe(): GameObservation<FakeGameState> {
    return {
      gameId: 'fake-game',
      saveId: 'default',
      revision: this.revision,
      observedAt: new Date().toISOString(),
      state: structuredClone(this.state),
    }
  }

  private move(params: JsonObject): JsonObject {
    const x = params.x
    const y = params.y
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('game.move requires integer x and y')
    const distance = Math.abs((x as number) - this.state.player.x) + Math.abs((y as number) - this.state.player.y)
    if (distance > this.state.player.energy) throw new Error('not enough energy to move')
    this.state.player.x = x as number
    this.state.player.y = y as number
    this.state.player.energy -= distance
    this.revision += 1
    this.emitStateChanged()
    return { moved: true, distance, revision: this.revision }
  }

  private collect(): JsonObject {
    if (this.state.coin.collected) throw new Error('coin was already collected')
    if (this.state.player.x !== this.state.coin.x || this.state.player.y !== this.state.coin.y) {
      throw new Error('player must stand on the coin before collecting it')
    }
    this.state.coin.collected = true
    this.state.player.coins += 1
    this.revision += 1
    this.emitStateChanged()
    return { collected: true, coins: this.state.player.coins, revision: this.revision }
  }

  private emitStateChanged(): void {
    const observation = this.observe()
    for (const listener of this.listeners) {
      listener({ method: 'game.state-changed', params: observation })
    }
  }
}
