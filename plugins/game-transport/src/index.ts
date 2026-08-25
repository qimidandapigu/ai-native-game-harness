import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import {
  WebSocketAdapterHost,
  type AdapterHostAddress,
  type RemoteGameAdapter,
} from '@ai-native-game-harness/adapter-websocket'
import {
  assertBridgeHello,
  type BridgeHello,
  type JsonObject,
  type JsonValue,
  type NativeBridge,
} from '@ai-native-game-harness/bridge-contract'
import { bindDshGameTools, type DshGameToolsBinding } from '@ai-native-game-harness/dsh-binding'
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

export interface Config {
  /** Start the Adapter Protocol 1.0 WebSocket host. Defaults to true when port is supplied. */
  enabled?: boolean
  host?: string
  port?: number
  path?: string
  requestTimeoutMs?: number
  /** Keep this plugin loading until the first Adapter has registered its DSH tools. */
  startupWaitForAdapterMs?: number
}

export class GameTransportService extends Service {
  private readonly bridges = new Map<string, BridgeRegistration>()
  private readonly bindings = new Map<string, DshGameToolsBinding>()
  private readonly firstAdapterReady: Promise<void>
  private resolveFirstAdapterReady!: () => void
  private adapterHost?: WebSocketAdapterHost

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'gameTransport')
    this.firstAdapterReady = new Promise(resolve => { this.resolveFirstAdapterReady = resolve })
  }

  start(): void {
    const enabled = this.config.enabled ?? this.config.port !== undefined
    if (!enabled || this.adapterHost !== undefined) return
    this.adapterHost = new WebSocketAdapterHost({
      host: this.config.host ?? '127.0.0.1',
      port: this.config.port ?? 33245,
      path: this.config.path ?? '/adapter',
      requestTimeoutMs: this.config.requestTimeoutMs,
      onAdapterReady: async adapter => this.connectAdapter(adapter),
    })
  }

  async adapterAddress(): Promise<AdapterHostAddress | undefined> {
    return await this.adapterHost?.ready()
  }

  boundToolNames(gameId: string): readonly string[] {
    return this.bindings.get(gameId)?.toolNames ?? []
  }

  async waitForFirstAdapter(timeoutMs: number): Promise<void> {
    if (this.bindings.size > 0) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.firstAdapterReady,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`No Adapter completed the DSH tool handshake within ${timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
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

  private async connectAdapter(adapter: RemoteGameAdapter): Promise<void> {
    const gameId = adapter.identity.gameId
    try {
      await this.ctx.gameCore.harness.connectAdapter(adapter)
      const binding = bindDshGameTools(this.ctx.tools, this.ctx.gameCore.harness, gameId)
      this.bindings.set(gameId, binding)
      this.resolveFirstAdapterReady()
      this.ctx.logger.info(
        'ai-native-game-transport: Adapter %s connected; registered DSH tools: %s',
        gameId,
        binding.toolNames.join(', '),
      )
    } catch (error) {
      await this.ctx.gameCore.harness.disconnectAdapter(gameId)
      throw error
    }
  }

  async close(): Promise<void> {
    for (const binding of this.bindings.values()) binding.dispose()
    this.bindings.clear()
    const host = this.adapterHost
    this.adapterHost = undefined
    await host?.close()
  }
}

export const name = 'ai-native-game-transport'
export const provide = 'gameTransport'
export const inject = ['gameCore', 'tools']

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const transport = new GameTransportService(ctx, config)
  ctx.effect(() => {
    transport.start()
    return async () => transport.close()
  })
  if ((config.startupWaitForAdapterMs ?? 0) > 0) {
    await transport.waitForFirstAdapter(config.startupWaitForAdapterMs!)
  }
}
