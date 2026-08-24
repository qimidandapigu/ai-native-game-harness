import { randomUUID } from 'node:crypto'
import {
  ADAPTER_PROTOCOL_VERSION,
  type ActionRequest,
  type ActionResult,
  type AdapterHello,
  type GameAdapter,
  type GameEvent,
  type GameObservation,
} from '@ai-native-game-harness/adapter-protocol'

interface MockState {
  player: { x: number; y: number; energy: number; coins: number }
  coin: { x: number; y: number; collected: boolean }
}

export class MockGameAdapter implements GameAdapter {
  #revision = 0
  #state: MockState = {
    player: { x: 0, y: 0, energy: 10, coins: 0 },
    coin: { x: 2, y: 1, collected: false },
  }
  readonly #listeners = new Set<(event: GameEvent) => void>()

  async hello(): Promise<AdapterHello> {
    return {
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      adapterId: 'mock-game.adapter',
      gameId: 'mock-game',
      displayName: 'Mock Coin Garden',
      adapterVersion: '0.1.0',
      capabilities: [
        { name: 'game.observe', kind: 'observation', description: 'Read authoritative game state.' },
        { name: 'game.move', kind: 'action', description: 'Move the player to a map coordinate.' },
        { name: 'game.collect', kind: 'action', description: 'Collect the coin at the player position.' },
        { name: 'game.reset', kind: 'action', description: 'Reset the deterministic demo state.' },
      ],
    }
  }

  async observe(): Promise<GameObservation> {
    return {
      gameId: 'mock-game',
      saveId: 'demo-save',
      revision: this.#revision,
      observedAt: new Date().toISOString(),
      state: JSON.parse(JSON.stringify(this.#state)) as GameObservation['state'],
    }
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    if (request.gameId !== 'mock-game') return this.#error(request, 'GAME_MISMATCH', 'Wrong gameId')
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.#revision) {
      return this.#error(request, 'REVISION_CONFLICT', 'Game state changed before the action ran')
    }
    if (request.capability === 'game.move') return this.#move(request)
    if (request.capability === 'game.collect') return this.#collect(request)
    if (request.capability === 'game.reset') {
      this.reset()
      this.#emit('game.reset', {})
      return { requestId: request.requestId, ok: true, revision: this.#revision, result: { reset: true } }
    }
    return this.#error(request, 'UNKNOWN_CAPABILITY', `Unknown capability: ${request.capability}`)
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  reset(): void {
    this.#revision = 0
    this.#state = {
      player: { x: 0, y: 0, energy: 10, coins: 0 },
      coin: { x: 2, y: 1, collected: false },
    }
  }

  #move(request: ActionRequest): ActionResult {
    const x = Number(request.arguments.x)
    const y = Number(request.arguments.y)
    if (!Number.isInteger(x) || !Number.isInteger(y)) return this.#error(request, 'INVALID_ARGUMENT', 'x and y must be integers')
    if (this.#state.player.energy < 1) return this.#error(request, 'NO_ENERGY', 'The player has no energy')
    this.#state.player.x = x
    this.#state.player.y = y
    this.#state.player.energy -= 1
    this.#revision += 1
    this.#emit('player.moved', { x, y })
    return { requestId: request.requestId, ok: true, revision: this.#revision, result: { x, y } }
  }

  #collect(request: ActionRequest): ActionResult {
    const player = this.#state.player
    const coin = this.#state.coin
    if (coin.collected) return this.#error(request, 'ALREADY_COLLECTED', 'The coin was already collected')
    if (player.x !== coin.x || player.y !== coin.y) return this.#error(request, 'OUT_OF_RANGE', 'Move to the coin first')
    coin.collected = true
    player.coins += 1
    this.#revision += 1
    this.#emit('coin.collected', { coins: player.coins })
    return { requestId: request.requestId, ok: true, revision: this.#revision, result: { coins: player.coins } }
  }

  #error(request: ActionRequest, code: string, message: string): ActionResult {
    return { requestId: request.requestId, ok: false, revision: this.#revision, error: { code, message } }
  }

  #emit(type: string, payload: GameEvent['payload']): void {
    const event: GameEvent = {
      eventId: randomUUID(),
      gameId: 'mock-game',
      revision: this.#revision,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    }
    for (const listener of this.#listeners) listener(event)
  }
}
