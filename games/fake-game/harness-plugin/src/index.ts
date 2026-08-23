import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertObservation, type GameObservation, type JsonObject } from '@ai-native-game-harness/bridge-contract'
import type {} from '@ai-native-game-harness/game-core'
import type {} from '@ai-native-game-harness/game-transport'

const GAME_ID = 'fake-game'

interface FakeState extends JsonObject {
  player: { x: number, y: number, energy: number, coins: number }
  coin: { x: number, y: number, collected: boolean }
}

export interface CollectCoinResult extends JsonObject {
  success: boolean
  moved: boolean
  collected: boolean
  revision: number
  coins: number
  energy: number
  reply: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fakeGameHarness: FakeGameHarnessService
  }
}

export class FakeGameHarnessService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fakeGameHarness')
  }

  async collectCoin(signal: AbortSignal): Promise<CollectCoinResult> {
    this.ctx.gameCore.record({ gameId: GAME_ID, layer: 'harness', operation: 'fake.collect-coin', status: 'started' })
    try {
      const before = await this.observe(signal)
      const state = before.state as FakeState
      let moved = false
      if (state.coin.collected) {
        const result = this.result(before, false, true, '金币已经收集过了。')
        this.ctx.gameCore.record({ gameId: GAME_ID, layer: 'harness', operation: 'fake.collect-coin', status: 'succeeded', output: result })
        return result
      }
      if (state.player.x !== state.coin.x || state.player.y !== state.coin.y) {
        await this.ctx.gameTransport.request(GAME_ID, 'game.move', { x: state.coin.x, y: state.coin.y }, signal)
        moved = true
      }
      await this.ctx.gameTransport.request(GAME_ID, 'game.collect', {}, signal)
      const after = await this.observe(signal)
      const result = this.result(after, moved, true, '已移动到金币位置并完成拾取。')
      this.ctx.gameCore.record({ gameId: GAME_ID, layer: 'harness', operation: 'fake.collect-coin', status: 'succeeded', output: result })
      return result
    } catch (error) {
      this.ctx.gameCore.record({
        gameId: GAME_ID,
        layer: 'harness',
        operation: 'fake.collect-coin',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async observe(signal: AbortSignal): Promise<GameObservation> {
    const value = await this.ctx.gameTransport.request(GAME_ID, 'game.observe', {}, signal)
    assertObservation(value)
    this.ctx.gameCore.updateObservation(value)
    return value
  }

  private result(observation: GameObservation, moved: boolean, collected: boolean, reply: string): CollectCoinResult {
    const state = observation.state as FakeState
    return {
      success: collected,
      moved,
      collected,
      revision: observation.revision,
      coins: state.player.coins,
      energy: state.player.energy,
      reply,
    }
  }
}

export const name = 'ai-native-fake-game-harness'
export const provide = 'fakeGameHarness'
export const inject = ['tools', 'gameCore', 'gameTransport']

export function apply(ctx: Context): void {
  const harness = new FakeGameHarnessService(ctx)
  const tool = defineTool({
    name: 'fake_collect_coin',
    description: 'Collect the visible coin in Fake Game. The Harness plugin observes state, moves through native game APIs, collects, then verifies the authoritative state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          moved: { type: 'boolean', required: true },
          collected: { type: 'boolean', required: true },
          revision: { type: 'integer', required: true },
          coins: { type: 'integer', required: true },
          energy: { type: 'integer', required: true },
          reply: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as unknown as CollectCoinResult).reply }],
    },
    execute: async (_args, exec) => harness.collectCoin(exec.signal),
  })
  ctx.effect(() => ctx.tools.register(tool))
}
