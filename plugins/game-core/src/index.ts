import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GameObservation, JsonValue } from '@ai-native-game-harness/bridge-contract'

export interface GameTraceEntry {
  id: string
  gameId: string
  layer: 'harness' | 'transport'
  operation: string
  status: 'started' | 'succeeded' | 'failed'
  timestamp: string
  input?: JsonValue
  output?: JsonValue
  error?: string
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    gameCore: GameCoreService
  }
}

export class GameCoreService extends Service {
  private readonly observations = new Map<string, GameObservation>()
  private readonly traces: GameTraceEntry[] = []

  constructor(ctx: Context) {
    super(ctx, 'gameCore')
  }

  updateObservation(observation: GameObservation): void {
    const key = this.observationKey(observation.gameId, observation.saveId)
    const previous = this.observations.get(key)
    if (previous !== undefined && observation.revision < previous.revision) {
      throw new Error(`stale observation revision ${observation.revision}; current is ${previous.revision}`)
    }
    this.observations.set(key, structuredClone(observation))
  }

  getObservation(gameId: string, saveId = 'default'): GameObservation | undefined {
    const value = this.observations.get(this.observationKey(gameId, saveId))
    return value === undefined ? undefined : structuredClone(value)
  }

  record(entry: Omit<GameTraceEntry, 'id' | 'timestamp'>): GameTraceEntry {
    const trace: GameTraceEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    }
    this.traces.push(structuredClone(trace))
    if (this.traces.length > 1_000) this.traces.shift()
    return trace
  }

  listTraces(gameId?: string): GameTraceEntry[] {
    return this.traces
      .filter(entry => gameId === undefined || entry.gameId === gameId)
      .map(entry => structuredClone(entry))
  }

  private observationKey(gameId: string, saveId: string): string {
    return `${gameId}\u0000${saveId}`
  }
}

export const name = 'ai-native-game-core'
export const provide = 'gameCore'

export function apply(ctx: Context): void {
  new GameCoreService(ctx)
}
