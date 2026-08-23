import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../src/config.js'
import { resolveMemoryIdentity } from '../src/runtime/memory/contracts.js'
import { MemoryService, parseMemoryExtraction } from '../src/runtime/memory/memory-service.js'
import { MemoryStore } from '../src/runtime/memory/memory-store.js'

const temporaryDirectories: string[] = []

function store(): MemoryStore {
  const directory = mkdtempSync(join(tmpdir(), 'xiaotangyuan-memory-test-'))
  temporaryDirectories.push(directory)
  const config: ResolvedConfig['memory'] = {
    enabled: true,
    autoLearn: true,
    directory,
    profileId: 'test-player',
    maxGameEntries: 50,
  }
  return new MemoryStore(config)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('XiaoTangYuan isolated memory', () => {
  it('shares the player profile but isolates game memory by game and save', () => {
    const memory = store()
    const farmA = { gameId: 'stardew-valley', saveId: 'farm-a' }
    const farmB = { gameId: 'stardew-valley', saveId: 'farm-b' }
    memory.updateSharedProfile({ interests: ['钓鱼'], playStyles: ['慢慢探索'] })
    memory.remember(farmA, [{ kind: 'goal', subject: 'community-center', summary: '想先修复社区中心', importance: 4 }], 'turn-1')

    expect(memory.recall(farmA, '今天做什么')).toContain('想先修复社区中心')
    expect(memory.recall(farmB, '今天做什么')).not.toContain('想先修复社区中心')
    expect(memory.recall({ gameId: 'oxygen-not-included', saveId: 'colony-a' }, '你好')).toContain('钓鱼')
    memory.close()
  })

  it('updates a repeated subject instead of accumulating raw history', () => {
    const memory = store()
    const identity = { gameId: 'dont-starve-together', saveId: 'world-a' }
    memory.remember(identity, [{ kind: 'goal', subject: 'base', summary: '准备在草原建家', importance: 3 }], 'turn-1')
    memory.remember(identity, [{ kind: 'goal', subject: 'base', summary: '决定把基地建在猪王附近', importance: 4 }], 'turn-2')

    expect(memory.listGameMemory(identity)).toHaveLength(1)
    expect(memory.listGameMemory(identity)[0]?.summary).toBe('决定把基地建在猪王附近')
    memory.close()
  })

  it('validates automatic extraction and ignores malformed output', () => {
    expect(parseMemoryExtraction('{"shared":{"interests":["种田"]},"gameMemories":[{"kind":"goal","subject":"矿洞","summary":"想下到 40 层","importance":4}]}')).toEqual({
      shared: { interests: ['种田'] },
      gameMemories: [{ kind: 'goal', subject: '矿洞', summary: '想下到 40 层', importance: 4 }],
    })
    expect(parseMemoryExtraction('not json')).toEqual({ gameMemories: [] })
  })

  it('prefers the current request save identity', () => {
    expect(resolveMemoryIdentity(
      { adapterId: 'test', gameId: 'test-game', version: '1', protocolVersion: '1.1', saveId: 'old-save' },
      { text: 'hi', context: { saveId: 'current-save' } },
    )).toEqual({ gameId: 'test-game', saveId: 'current-save' })
  })

  it('tracks sessions, distinct local play days, duration and save counts without mixing saves', () => {
    const memory = store()
    const farmA = { gameId: 'stardew-valley', saveId: 'farm-a' }
    const farmB = { gameId: 'stardew-valley', saveId: 'farm-b' }
    const day1 = new Date(2026, 7, 18, 20).getTime()
    const day2 = new Date(2026, 7, 19, 20).getTime()
    const day3 = new Date(2026, 7, 20, 20).getTime()
    memory.beginPlaySession('session-a', farmA, day1)
    memory.touchPlaySession('session-a', farmA, day2)
    memory.endPlaySession('session-a', farmA, day3)
    memory.beginPlaySession('session-b', farmB, day3)
    memory.endPlaySession('session-b', farmB, day3 + 60_000)

    const stats = memory.listPlayStatistics()
    expect(stats.find(item => item.saveId === 'farm-a')).toMatchObject({ playDays: 3, sessionCount: 1, activeMs: 240_000 })
    expect(stats.find(item => item.saveId === 'farm-b')).toMatchObject({ playDays: 1, sessionCount: 1, activeMs: 60_000 })
    expect(memory.listGamePlayStatistics()).toEqual([expect.objectContaining({
      gameId: 'stardew-valley', playDays: 3, saveCount: 2, sessionCount: 2, activeMs: 300_000,
    })])
    memory.close()
  })

  it('supports explicit correction and deletion for player-managed memory', () => {
    const memory = store()
    const identity = { gameId: 'oxygen-not-included', saveId: 'colony-a' }
    memory.updateSharedProfile({ interests: ['钓鱼', '种田'] })
    expect(memory.replaceSharedField('interests', ['自动化']).interests).toEqual(['自动化'])
    memory.remember(identity, [{ kind: 'decision', subject: 'power', summary: '先建设煤炭发电', importance: 3 }], 'turn-1')
    const event = memory.listGameMemory(identity)[0]
    expect(event).toBeDefined()
    expect(memory.deleteGameMemory(event!.id)).toBe(true)
    expect(memory.listGameMemory(identity)).toHaveLength(0)
    memory.close()
  })

  it('creates a compact stage summary after a conversational play session ends', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xiaotangyuan-memory-test-'))
    temporaryDirectories.push(directory)
    let modelCalls = 0
    const ctx = {
      llm: {
        stream: async function* () {
          modelCalls += 1
          const text = modelCalls === 3
            ? '{"shared":null,"gameMemories":[{"kind":"milestone","subject":"session-summary","summary":"完成矿洞探索并决定下次准备补给","importance":4}]}'
            : '{"shared":null,"gameMemories":[]}'
          yield { type: 'text-delta', index: 0, text }
        },
      },
      logger: { warn: () => undefined },
    } as unknown as Context
    const service = new MemoryService(ctx, {
      enabled: true, autoLearn: true, directory, profileId: 'test-player', maxGameEntries: 50,
    })
    const adapter = { adapterId: 'test', gameId: 'stardew-valley', version: '1', protocolVersion: '1.1', saveId: 'farm-a' }
    const selection = { provider: 'test-provider', model: 'test-model' }
    service.adapterConnected('connection-a', adapter)
    service.scheduleLearn('connection-a', adapter, { text: '今天去矿洞', context: { saveId: 'farm-a' } }, '好，我们出发。', 'turn-1', selection)
    service.scheduleLearn('connection-a', adapter, { text: '下次先准备补给', context: { saveId: 'farm-a' } }, '记住了。', 'turn-2', selection)
    service.endSession('connection-a')
    await service.flush()

    expect(modelCalls).toBe(3)
    expect(service.store.listGameMemory({ gameId: 'stardew-valley', saveId: 'farm-a' })[0]?.summary).toContain('下次准备补给')
    await service.close()
  })
})
