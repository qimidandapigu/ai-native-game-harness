import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GameObservation, JsonValue } from '@ai-native-game-harness/bridge-contract'
import { HarnessCore, type HarnessSnapshot } from '@ai-native-game-harness/harness-core'

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

/** Machine-readable stdout record consumed by the Desktop main process. */
export const PRODUCT_SNAPSHOT_PREFIX = 'AI_GAME_HARNESS_SNAPSHOT '

export interface Config {
  /** Emit machine-readable snapshots for the Desktop parent process. */
  productSnapshotOutput?: boolean
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    gameCore: GameCoreService
  }
}

export class GameCoreService extends Service {
  /** The DSH-first product Core used by Adapter Protocol 1.0 and dsh-binding. */
  readonly harness = new HarnessCore()
  private readonly observations = new Map<string, GameObservation>()
  private readonly traces: GameTraceEntry[] = []
  private readonly unsubscribeProductSnapshot: () => void

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'gameCore')
    this.unsubscribeProductSnapshot = config.productSnapshotOutput
      ? this.harness.subscribe(snapshot => this.publishProductSnapshot(snapshot))
      : () => undefined
    if (config.productSnapshotOutput) queueMicrotask(() => this.publishProductSnapshot(this.harness.snapshot()))
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

  snapshot(): HarnessSnapshot {
    return this.harness.snapshot()
  }

  async close(): Promise<void> {
    this.unsubscribeProductSnapshot()
    await this.harness.close()
  }

  private publishProductSnapshot(snapshot: HarnessSnapshot): void {
    process.stdout.write(`${PRODUCT_SNAPSHOT_PREFIX}${JSON.stringify(snapshot)}\n`)
  }

  private observationKey(gameId: string, saveId: string): string {
    return `${gameId}\u0000${saveId}`
  }
}

export const name = 'ai-native-game-core'
export const provide = 'gameCore'

export function apply(ctx: Context, config: Config = {}): void {
  const core = new GameCoreService(ctx, config)
  ctx.effect(() => async () => core.close())
}
