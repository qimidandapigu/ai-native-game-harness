import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as gameCorePlugin from '@ai-native-game-harness/game-core'
import * as gameTransportPlugin from '@ai-native-game-harness/game-transport'
import * as oniAdapterPlugin from '@qimidandapigu/oni-adapter'
import { describe, expect, it } from 'vitest'

describe('ONI production Harness route without a running game', () => {
  it('registers ONI actions through Adapter Protocol and records the real Core trace', async () => {
    const bridgeRoot = await mkdtemp(join(tmpdir(), 'oni-harness-runtime-'))
    const sessionDir = join(bridgeRoot, String(process.pid))
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ processId: process.pid, saveId: 'fake-colony' }))
    const state = {
      id: 'state-1',
      method: 'state.update',
      params: {
        observation: {
          meta: { capturedAt: '2026-08-26T00:00:00.000Z' },
          cursor: { cell: 123 },
          duplicants: [],
        },
      },
    }
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state] }))

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
    const oniFiber = await ctx.plugin(oniAdapterPlugin, {
      bridgeRoot,
      adapterProtocolUrl: address.url,
      port: 33145,
    })

    try {
      await waitFor(() => ctx.gameTransport.boundToolNames('oxygen-not-included').length > 0)
      const toolName = ctx.gameTransport.boundToolNames('oxygen-not-included')
        .find(name => name.includes('oni_dig'))
      expect(toolName).toBe('game_oxygen-not-included_oni_dig')
      expect(ctx.tools.schemas().some(schema => schema.name === 'oni_dig')).toBe(false)

      const execution = ctx.tools.execute({
        callId: CallId('oni-harness-call-1'),
        name: toolName!,
        arguments: { actorScope: 'colony' },
        signal: new AbortController().signal,
      })
      await waitFor(async () => {
        try {
          const inbox = JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')) as {
            events: Array<{ method: string, params: { callId?: string } }>
          }
          return inbox.events.some(event => event.method === 'tool.execute' && event.params.callId === 'oni-harness-call-1')
        } catch {
          return false
        }
      })
      await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state, {
        id: 'result-1',
        method: 'tool.result',
        params: {
          callId: 'oni-harness-call-1',
          success: true,
          reply: '已创建挖掘任务',
          gameExecutionMs: 7,
        },
      }] }))

      await expect(execution).resolves.toMatchObject({
        isError: false,
        value: {
          result: { requestId: 'oni-harness-call-1', ok: true, revision: 1 },
          observation: { gameId: 'oxygen-not-included', revision: 1 },
        },
      })
      expect(ctx.gameCore.snapshot()).toMatchObject({
        adapters: [{ gameId: 'oxygen-not-included', status: 'connected' }],
        observations: [{ gameId: 'oxygen-not-included', revision: 1 }],
      })
      expect(ctx.gameCore.snapshot().traces).toContainEqual(expect.objectContaining({
        kind: 'action.executed',
        gameId: 'oxygen-not-included',
        detail: expect.objectContaining({
          requestId: 'oni-harness-call-1',
          ok: true,
          bridgeRoundTripMs: expect.any(Number),
          gameExecutionMs: 7,
        }),
      }))
    } finally {
      await oniFiber.dispose()
      await transportFiber.dispose()
      await coreFiber.dispose()
      await toolsFiber.dispose()
      await releaseSystemPrompt()
      await rm(bridgeRoot, { recursive: true, force: true })
    }
  })
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
