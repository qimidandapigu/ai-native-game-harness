import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { ReconnectingAdapterClient, WebSocketAdapterHost, type RemoteGameAdapter } from '@ai-native-game-harness/adapter-websocket'
import { resolveConfig } from '../src/config.js'
import { OniAdapter } from '../src/index.js'

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

describe('ONI Adapter file bridge', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

  it('resolves the default Windows bridge directory with path separators', () => {
    const resolved = resolveConfig()
    expect(resolved.bridgeRoot).toBe(join(process.env.LOCALAPPDATA ?? process.cwd(), 'XiaoTangYuan', 'oni-bridge'))
  })

  it('grounds tool actions to the latest cursor and returns the C# result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oni-adapter-'))
    const processId = process.pid
    const sessionDir = join(root, String(processId))
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ processId }))
    const staleDir = join(root, '99999999')
    await mkdir(staleDir)
    await writeFile(join(staleDir, 'session.json'), JSON.stringify({ processId: 99999999 }))
    const state = { id: 'state-1', method: 'state.update', params: { observation: { cursor: { cell: 123 }, duplicants: [] } } }
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state] }))

    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('missing test port')
    const adapter = new OniAdapter(root, `ws://127.0.0.1:${address.port}`)
    adapter.start()
    cleanups.push(async () => { await adapter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })

    await until(async () => {
      try {
        const inbox = JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')) as { events: Array<{ method: string, params: { callId?: string, args?: { targetCell?: number } } }> }
        return inbox.events.find(event => event.method === 'tool.execute')
      } catch { return undefined }
    }, 50).catch(() => undefined)

    await until(async () => server.clients.size > 0 ? true : undefined)
    const execution = adapter.executeTool('oni_dig', { actorScope: 'colony' }, AbortSignal.timeout(3_000))
    const request = await until(async () => {
      try {
        const inbox = JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')) as { events: Array<{ method: string, params: { callId?: string, args?: { targetCell?: number } } }> }
        return inbox.events.find(event => event.method === 'tool.execute')
      } catch { return undefined }
    })
    expect(request.params.args?.targetCell).toBe(123)
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state, { id: 'result-1', method: 'tool.result', params: { callId: request.params.callId, success: true, reply: '已创建挖掘任务' } }] }))
    await expect(execution).resolves.toEqual({ success: true, reply: '已创建挖掘任务' })
  })
})

describe('ONI Game Adapter protocol without a running game', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  async function fixture(executionTimeoutMs = 1_000) {
    const root = await mkdtemp(join(tmpdir(), 'oni-protocol-'))
    const processId = 4242
    const sessionDir = join(root, String(processId))
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ processId, saveId: 'fake-colony' }))
    const state = {
      id: 'state-1',
      method: 'state.update',
      params: {
        observation: {
          meta: { capturedAt: '2026-08-25T03:00:00.000Z' },
          cursor: { cell: 123 },
          duplicants: [],
        },
      },
    }
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state] }))
    const adapter = new OniAdapter(root, undefined, () => true, executionTimeoutMs)
    adapter.start()
    cleanups.push(async () => { await adapter.close(); await rm(root, { recursive: true, force: true }) })
    await until(async () => adapter.observe().catch(() => undefined))
    return { adapter, root, sessionDir, state }
  }

  it('announces capabilities, observes a stable revision, and emits a state event once', async () => {
    const { adapter, sessionDir, state } = await fixture()
    const listener = vi.fn()
    adapter.subscribe(listener)

    const hello = await adapter.hello()
    expect(hello).toMatchObject({ protocolVersion: '1.0', gameId: 'oxygen-not-included' })
    expect(hello.capabilities.find(item => item.name === 'oni_dig')).toMatchObject({
      kind: 'action',
      inputSchema: { type: 'object' },
    })
    const first = await adapter.observe()
    await new Promise(resolve => setTimeout(resolve, 220))
    const second = await adapter.observe()
    expect(first).toMatchObject({ saveId: 'fake-colony', revision: 1, observedAt: '2026-08-25T03:00:00.000Z' })
    expect(second.revision).toBe(first.revision)
    // Subscription happened after the initial state, so an unchanged outbox
    // must not replay the event or advance the revision.
    expect(listener).not.toHaveBeenCalled()
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state, {
      id: 'state-2',
      method: 'state.update',
      params: { observation: { meta: { capturedAt: '2026-08-25T03:00:01.000Z' }, cursor: { cell: 124 } } },
    }] }))
    await until(async () => listener.mock.calls.length === 1 ? true : undefined)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'state-2', revision: 2, type: 'state.updated' }))
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state, {
      id: 'state-2', method: 'state.update', params: { observation: { cursor: { cell: 124 } } },
    }, {
      id: 'chat-1', method: 'chat.send', params: { context: { observation: { cursor: { cell: 124 } } } },
    }] }))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await adapter.observe()).revision).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps requestId through the file bridge and reports measured timing segments', async () => {
    const { adapter, sessionDir, state } = await fixture()
    const execution = adapter.execute({
      requestId: 'dsh-call-123',
      gameId: 'oxygen-not-included',
      capability: 'oni_dig',
      arguments: { actorScope: 'colony' },
      expectedRevision: 1,
    })
    const request = await until(async () => {
      try {
        const inbox = JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')) as { events: Array<{ method: string, params: { callId?: string, args?: { targetCell?: number } } }> }
        return inbox.events.find(event => event.method === 'tool.execute')
      } catch { return undefined }
    })
    expect(request.params).toMatchObject({ callId: 'dsh-call-123', args: { targetCell: 123 } })
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({
      events: [state, {
        id: 'result-1',
        method: 'tool.result',
        params: { callId: 'dsh-call-123', success: true, reply: '已创建挖掘任务', gameExecutionMs: 7 },
      }],
    }))
    await expect(execution).resolves.toMatchObject({
      requestId: 'dsh-call-123',
      ok: true,
      revision: 1,
      result: { reply: '已创建挖掘任务' },
      timing: { bridgeRoundTripMs: expect.any(Number), gameExecutionMs: 7 },
    })
  })

  it('runs the same fake Bridge through the real WebSocket handshake and action wire', async () => {
    const { adapter, sessionDir, state } = await fixture()
    let remote: RemoteGameAdapter | undefined
    const host = new WebSocketAdapterHost({
      host: '127.0.0.1',
      port: 0,
      requestTimeoutMs: 2_000,
      onAdapterReady: value => { remote = value },
    })
    const address = await host.ready()
    const client = new ReconnectingAdapterClient({
      url: address.url,
      adapter,
      reconnectMinMs: 30,
      reconnectMaxMs: 60,
      requestTimeoutMs: 2_000,
    })
    client.start()
    cleanups.push(async () => { await client.stop(); await host.close() })
    await client.waitUntilConnected(2_000)
    const connected = await until(async () => remote)
    await expect(connected.observe()).resolves.toMatchObject({ gameId: 'oxygen-not-included', revision: 1 })

    const execution = connected.execute({
      requestId: 'wire-call-1', gameId: 'oxygen-not-included', capability: 'oni_dig', arguments: {}, expectedRevision: 1,
    })
    await until(async () => {
      try {
        const inbox = JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')) as { events: Array<{ params: { callId?: string } }> }
        return inbox.events.some(event => event.params.callId === 'wire-call-1') ? true : undefined
      } catch { return undefined }
    })
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state, {
      id: 'wire-result-1', method: 'tool.result', params: { callId: 'wire-call-1', success: true, reply: 'wire ok', gameExecutionMs: 5 },
    }] }))
    await expect(execution).resolves.toMatchObject({
      requestId: 'wire-call-1', ok: true, timing: { bridgeRoundTripMs: expect.any(Number), gameExecutionMs: 5 },
    })
  })

  it('rejects stale revisions, unavailable actions, bridge rejection, and timeout deterministically', async () => {
    const { adapter, sessionDir, state } = await fixture(350)
    await expect(adapter.execute({
      requestId: 'stale-call', gameId: 'oxygen-not-included', capability: 'oni_dig', arguments: {}, expectedRevision: 0,
    })).resolves.toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
    await expect(adapter.execute({
      requestId: 'unknown-call', gameId: 'oxygen-not-included', capability: 'oni_delete_save', arguments: {}, expectedRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } })

    const rejected = adapter.execute({
      requestId: 'rejected-call', gameId: 'oxygen-not-included', capability: 'oni_dig', arguments: {}, expectedRevision: 1,
    })
    await until(async () => {
      try {
        const inbox = JSON.parse(await readFile(join(sessionDir, 'inbox.json'), 'utf8')) as { events: Array<{ params: { callId?: string } }> }
        return inbox.events.some(event => event.params.callId === 'rejected-call') ? true : undefined
      } catch { return undefined }
    })
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [state, {
      id: 'result-rejected', method: 'tool.result', params: { callId: 'rejected-call', success: false, reply: '目标格不可挖掘', gameExecutionMs: 2 },
    }] }))
    await expect(rejected).resolves.toMatchObject({ ok: false, error: { code: 'ACTION_REJECTED', message: '目标格不可挖掘' } })

    await expect(adapter.execute({
      requestId: 'timeout-call', gameId: 'oxygen-not-included', capability: 'oni_dig', arguments: {}, expectedRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'REQUEST_TIMEOUT' } })
  })

  it('reports fake bridge disconnect and reconnect without launching ONI', async () => {
    const { adapter, sessionDir } = await fixture()
    const states: string[] = []
    adapter.subscribeConnection(state => states.push(state))
    await rm(sessionDir, { recursive: true, force: true })
    await until(async () => adapter.connectionState() === 'disconnected' ? true : undefined)
    await mkdir(sessionDir)
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ processId: 4242, saveId: 'fake-colony-2' }))
    await writeFile(join(sessionDir, 'outbox.json'), JSON.stringify({ events: [{
      id: 'state-2', method: 'state.update', params: { observation: { meta: { capturedAt: '2026-08-25T03:01:00.000Z' }, cursor: { cell: 456 } } },
    }] }))
    await until(async () => adapter.connectionState() === 'connected' ? true : undefined)
    await until(async () => (await adapter.observe()).saveId === 'fake-colony-2' ? true : undefined)
    expect(states).toEqual(['disconnected', 'connected'])
    expect(await adapter.observe()).toMatchObject({ saveId: 'fake-colony-2', revision: 2 })
  })
})
