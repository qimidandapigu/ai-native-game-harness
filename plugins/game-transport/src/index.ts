import { Service, type Context } from '@deepseek-ai/cordis'
import {
  assertBridgeHello,
  type BridgeHello,
  type JsonObject,
  type JsonValue,
  type NativeBridge,
} from '@ai-native-game-harness/bridge-contract'
import type {} from '@ai-native-game-harness/game-core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gameTransport: GameTransportService
  }
}
interface BridgeRegistration {
  bridge: NativeBridge
  hello: BridgeHello
  unsubscribe: () => void
}

export class GameTransportService extends Service {
  private readonly bridges = new Map<string, BridgeRegistration>()

  constructor(ctx: Context) {
    super(ctx, 'gameTransport')
  }

  registerBridge(bridge: NativeBridge): () => void {
    const hello = bridge.hello()
    assertBridgeHello(hello)
    if (this.bridges.has(hello.gameId)) {
      throw new Error(`game bridge already connected: ${hello.gameId}`)
    }
    const unsubscribe = bridge.subscribe(event => {
      this.ctx.gameCore.record({
        gameId: hello.gameId,
        layer: 'transport',
        operation: `event:${event.method}`,
        status: 'succeeded',
        output: event.params,
      })
    })
    const registration = { bridge, hello, unsubscribe }
    this.bridges.set(hello.gameId, registration)
    return () => {
      if (this.bridges.get(hello.gameId) !== registration) return
      this.bridges.delete(hello.gameId)
      unsubscribe()
      void bridge.close()
    }
  }

  getBridge(gameId: string): BridgeHello | undefined {
    const hello = this.bridges.get(gameId)?.hello
    return hello === undefined ? undefined : structuredClone(hello)
  }

  async request(gameId: string, method: string, params: JsonObject, signal: AbortSignal): Promise<JsonValue> {
    const registration = this.bridges.get(gameId)
    if (registration === undefined) throw new Error(`game bridge is not connected: ${gameId}`)
    this.ctx.gameCore.record({ gameId, layer: 'transport', operation: method, status: 'started', input: params })
    try {
      const output = await registration.bridge.request(method, params, signal)
      this.ctx.gameCore.record({ gameId, layer: 'transport', operation: method, status: 'succeeded', output })
      return output
    } catch (error) {
      this.ctx.gameCore.record({
        gameId,
        layer: 'transport',
        operation: method,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

export const name = 'ai-native-game-transport'
export const provide = 'gameTransport'
export const inject = ['gameCore']

export function apply(ctx: Context): void {
  new GameTransportService(ctx)
}
