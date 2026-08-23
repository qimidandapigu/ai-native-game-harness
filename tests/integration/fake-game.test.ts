import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import * as gameCorePlugin from '@ai-native-game-harness/game-core'
import * as gameTransportPlugin from '@ai-native-game-harness/game-transport'
import * as fakeGameHarnessPlugin from '@ai-native-game-harness/fake-game-harness'
import { FakeNativeBridge } from '@ai-native-game-harness/fake-native-bridge'
import { describe, expect, it } from 'vitest'

class MockTools {
  private readonly definitions = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    if (this.definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
    this.definitions.set(definition.name, definition)
    return () => this.definitions.delete(definition.name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name)
  }

  async execute(name: string, args: unknown): Promise<unknown> {
    const definition = this.definitions.get(name)
    if (definition === undefined) throw new Error(`unknown tool: ${name}`)
    return definition.execute(args, {
      signal: new AbortController().signal,
      deferContext: () => undefined,
      concludeTurn: () => undefined,
    } as never)
  }
}

describe('Fake Game vertical slice', () => {
  it('keeps native game rules authoritative inside the Bridge', async () => {
    const bridge = new FakeNativeBridge()
    await expect(bridge.request('game.collect', {}, new AbortController().signal))
      .rejects.toThrow('player must stand on the coin')
    expect(bridge.snapshot()).toMatchObject({
      revision: 0,
      state: { player: { coins: 0 }, coin: { collected: false } },
    })
  })

  it('loads as Cordis plugins and changes authoritative game state through the Bridge', async () => {
    const ctx = new Context()
    const tools = new MockTools()
    const releaseTools = ctx.provide('tools', tools)
    const coreFiber = await ctx.plugin(gameCorePlugin)
    const transportFiber = await ctx.plugin(gameTransportPlugin)
    const bridge = new FakeNativeBridge()
    const unregisterBridge = ctx.gameTransport.registerBridge(bridge)
    const harnessFiber = await ctx.plugin(fakeGameHarnessPlugin)

    expect(tools.get('fake_collect_coin')).toBeDefined()
    const result = await tools.execute('fake_collect_coin', {})

    expect(result).toMatchObject({
      success: true,
      moved: true,
      collected: true,
      revision: 2,
      coins: 1,
      energy: 7,
    })
    expect(bridge.snapshot()).toMatchObject({
      revision: 2,
      state: {
        player: { x: 2, y: 1, energy: 7, coins: 1 },
        coin: { x: 2, y: 1, collected: true },
      },
    })
    expect(ctx.gameCore.getObservation('fake-game')).toMatchObject({ revision: 2 })

    const successfulCalls = ctx.gameCore.listTraces('fake-game')
      .filter(entry => entry.layer === 'transport' && entry.status === 'succeeded' && !entry.operation.startsWith('event:'))
      .map(entry => entry.operation)
    expect(successfulCalls).toEqual(['game.observe', 'game.move', 'game.collect', 'game.observe'])
    expect(ctx.gameCore.listTraces('fake-game')).toContainEqual(expect.objectContaining({
      layer: 'harness',
      operation: 'fake.collect-coin',
      status: 'succeeded',
    }))

    await expect(tools.execute('fake_collect_coin', {})).resolves.toMatchObject({
      success: true,
      moved: false,
      collected: true,
      revision: 2,
      coins: 1,
    })

    await harnessFiber.dispose()
    expect(tools.get('fake_collect_coin')).toBeUndefined()
    unregisterBridge()
    await transportFiber.dispose()
    await coreFiber.dispose()
    await releaseTools()
  })
})
