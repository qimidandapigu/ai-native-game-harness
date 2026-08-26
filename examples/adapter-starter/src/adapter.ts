import { randomUUID } from 'node:crypto'
import type {
  ActionRequest,
  ActionResult,
  AdapterHello,
  GameAdapter,
  GameEvent,
  GameObservation,
} from '@ai-native-game-harness/adapter-protocol'

interface StarterState {
  revision: number
  value: number
}

/** Replace this in-memory state with your game's official API or thin native Bridge. */
export class StarterGameAdapter implements GameAdapter {
  readonly #listeners = new Set<(event: GameEvent) => void>()
  readonly #state: StarterState = { revision: 0, value: 0 }

  async hello(): Promise<AdapterHello> {
    return {
      protocolVersion: '1.0',
      adapterId: 'adapter-starter.adapter',
      gameId: 'adapter-starter-game',
      displayName: 'Adapter Starter Game',
      adapterVersion: '0.1.0',
      capabilities: [
        { kind: 'observation', name: 'game.observe', description: 'Read authoritative game state.' },
        {
          kind: 'action',
          name: 'game.increment',
          description: 'Increment the starter value.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { amount: { type: 'integer', minimum: 1, maximum: 10 } },
            required: ['amount'],
          },
        },
      ],
    }
  }

  async observe(): Promise<GameObservation> {
    return {
      gameId: 'adapter-starter-game',
      saveId: 'default',
      revision: this.#state.revision,
      observedAt: new Date().toISOString(),
      state: { value: this.#state.value },
    }
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.#state.revision) {
      return {
        requestId: request.requestId,
        ok: false,
        revision: this.#state.revision,
        error: { code: 'REVISION_CONFLICT', message: 'Refresh state and retry.' },
      }
    }
    if (request.capability !== 'game.increment') {
      return {
        requestId: request.requestId,
        ok: false,
        revision: this.#state.revision,
        error: { code: 'UNKNOWN_CAPABILITY', message: `Unknown capability: ${request.capability}` },
      }
    }
    const amount = Number(request.arguments.amount)
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10) {
      return {
        requestId: request.requestId,
        ok: false,
        revision: this.#state.revision,
        error: { code: 'INVALID_ARGUMENT', message: 'amount must be an integer from 1 to 10.' },
      }
    }
    this.#state.value += amount
    this.#state.revision += 1
    const event: GameEvent = {
      eventId: randomUUID(),
      gameId: 'adapter-starter-game',
      type: 'starter.value.changed',
      revision: this.#state.revision,
      occurredAt: new Date().toISOString(),
      payload: { value: this.#state.value },
    }
    for (const listener of this.#listeners) listener(event)
    return {
      requestId: request.requestId,
      ok: true,
      revision: this.#state.revision,
      result: { value: this.#state.value },
    }
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
