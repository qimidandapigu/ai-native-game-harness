import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ReconnectingAdapterClient } from '@ai-native-game-harness/adapter-websocket'
import * as gameCorePlugin from '@ai-native-game-harness/game-core'
import * as gameTransportPlugin from '@ai-native-game-harness/game-transport'
import { MockGameAdapter } from '@ai-native-game-harness/mock-game/adapter'
import { describe, expect, it } from 'vitest'

describe('DSH Adapter runtime vertical slice', () => {
  it('registers remote Adapter actions in the real DSH ToolRuntime and returns authoritative results', async () => {
    const ctx = new Context()
    const releaseSystemPrompt = ctx.provide('systemPrompt', {
      tools: () => undefined,
      section: () => undefined,
    } as never)
    const toolsFiber = await ctx.plugin(ToolRuntime, { mode: 'native' })
    const coreFiber = await ctx.plugin(gameCorePlugin)
    const transportFiber = await ctx.plugin(gameTransportPlugin, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      path: '/adapter',
      requestTimeoutMs: 2_000,
    })
    const address = await ctx.gameTransport.adapterAddress()
    if (address === undefined) throw new Error('Adapter Host did not start')
    const client = new ReconnectingAdapterClient({
      url: address.url,
      adapter: new MockGameAdapter(),
      reconnectMinMs: 30,
      reconnectMaxMs: 60,
      requestTimeoutMs: 2_000,
    })
    client.start()

    try {
      await client.waitUntilConnected(3_000)
      await waitFor(() => ctx.gameTransport.boundToolNames('mock-game').length === 3)

      expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
        'game_mock-game_game_move',
        'game_mock-game_game_collect',
        'game_mock-game_game_reset',
      ]))

      const rejected = await ctx.tools.execute({
        callId: CallId('dsh-runtime-rejected'),
        name: 'game_mock-game_game_collect',
        arguments: {},
        signal: new AbortController().signal,
      })
      expect(rejected).toMatchObject({
        isError: false,
        value: { result: { ok: false, error: { code: 'OUT_OF_RANGE' } }, observation: { revision: 0 } },
      })

      const moved = await ctx.tools.execute({
        callId: CallId('dsh-runtime-move'),
        name: 'game_mock-game_game_move',
        arguments: { x: 2, y: 1 },
        signal: new AbortController().signal,
      })
      expect(moved).toMatchObject({
        isError: false,
        value: { result: { ok: true, revision: 1 }, observation: { revision: 1 } },
      })

      const collected = await ctx.tools.execute({
        callId: CallId('dsh-runtime-collect'),
        name: 'game_mock-game_game_collect',
        arguments: {},
        signal: new AbortController().signal,
      })
      expect(collected).toMatchObject({
        isError: false,
        value: {
          result: { ok: true, revision: 2, result: { coins: 1 } },
          observation: { revision: 2, state: { player: { coins: 1 }, coin: { collected: true } } },
        },
      })
      expect(ctx.gameCore.snapshot().traces.filter(trace => trace.kind === 'action.executed')).toHaveLength(3)
    } finally {
      await client.stop()
      await transportFiber.dispose()
      expect(ctx.tools.schemas().some(schema => schema.name.startsWith('game_mock-game_'))).toBe(false)
      await coreFiber.dispose()
      await toolsFiber.dispose()
      await releaseSystemPrompt()
    }
  })
})

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
