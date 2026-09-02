import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameGateway } from '../src/gateway/game-gateway.js'

const openServers = new Set<Server>()

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  openServers.add(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('test server did not expose a TCP port')
  return address.port
}

async function close(server: Server): Promise<void> {
  openServers.delete(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function createGateway(port: number, warn = vi.fn()): GameGateway {
  return new GameGateway(
    { logger: { warn } } as never,
    '127.0.0.1',
    port,
    {} as never,
    undefined,
    undefined,
    {} as never,
    { enabled: false, intervalSeconds: 180 },
    () => undefined,
    false,
    async () => undefined,
    async () => undefined,
    async () => false,
  )
}

afterEach(async () => {
  await Promise.allSettled([...openServers].map(server => close(server)))
  vi.restoreAllMocks()
})

describe('game gateway lifecycle', () => {
  it('retries a transient port collision and binds after the old owner exits', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const blocker = createServer()
    const port = await listen(blocker)
    const warn = vi.fn()
    const gateway = createGateway(port, warn)

    const starting = gateway.start([20, 40, 80, 160])
    setTimeout(() => void close(blocker), 50)
    await starting

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('暂时被占用'))
    await gateway.close()
    const proof = createServer()
    await listen(proof, port)
    await close(proof)
  })

  it('fails startup instead of silently continuing when the port stays occupied', async () => {
    const blocker = createServer()
    const port = await listen(blocker)
    const gateway = createGateway(port)

    await expect(gateway.start([10, 20])).rejects.toThrow(`ws://127.0.0.1:${port}`)
    await gateway.close()
    await close(blocker)
  })
})
