import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
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
    cleanups.push(async () => { adapter.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })

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
