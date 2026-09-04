import { describe, expect, it } from 'vitest'
import { buildGameViewModel, safeStatePreview } from '../../apps/desktop/src/game-view-models.mjs'

const capability = (name: string, kind: 'action' | 'observation' = 'action') => ({ name, kind })

describe('Desktop game view models', () => {
  it('renders an unknown Adapter immediately through the generic fallback', () => {
    const view = buildGameViewModel({
      gameId: 'community-space-game',
      displayName: 'Community Space Game',
      capabilities: [capability('ship.scan', 'observation'), capability('ship.move')],
    }, {
      gameId: 'community-space-game',
      saveId: 'sector-a',
      revision: 4,
      state: { ship: { name: 'Explorer' }, nearbyPlanets: ['A', 'B'], fuel: 72 },
    })

    expect(view).toMatchObject({
      kind: 'generic',
      title: 'Community Space Game',
      metrics: [
        { label: '状态字段', value: 3 },
        { label: '动作能力', value: 1 },
        { label: '存档', value: 'sector-a' },
      ],
    })
    expect(view.sections[0].items).toEqual(expect.arrayContaining([
      { label: 'ship', value: 'Explorer' },
      { label: 'nearbyPlanets', value: '2 项' },
      { label: 'fuel', value: '72' },
    ]))
  })

  it('turns the standard ONI context into a colony summary', () => {
    const view = buildGameViewModel({
      gameId: 'oxygen-not-included',
      displayName: 'Oxygen Not Included / 缺氧',
      capabilities: [capability('oni_dig')],
    }, {
      gameId: 'oxygen-not-included',
      saveId: 'colony-a',
      revision: 8,
      state: {
        schema: 'ai-native.game-context.v1',
        player: { id: 42 },
        entities: [
          { id: 42, kind: 'character', name: '阿汪', selected: true, position: { space: 'cell', cell: 123 } },
          { id: 43, kind: 'character', name: '小梅', position: { space: 'cell', cell: 125 }, reachableFromCursor: false },
        ],
        ui: { cursor: { space: 'cell', cell: 456, element: 'Water', solid: false } },
        extensions: { oni: { summary: '氧气稳定，食物偏低。', selectedDuplicantId: 42 } },
      },
    })

    expect(view).toMatchObject({
      kind: 'oni',
      title: '《缺氧》殖民地',
      metrics: [
        { label: '复制人', value: 2 },
        { label: '当前选择', value: '阿汪' },
        { label: '光标格', value: 456 },
      ],
    })
    expect(view.sections[0]).toMatchObject({ title: '殖民地摘要', text: '氧气稳定，食物偏低。' })
    expect(view.sections[1].items).toContainEqual({ label: '阿汪', value: '已选择 · 格子 123' })
  })

  it('keeps the deterministic Mock Game map as an optional dedicated renderer', () => {
    const view = buildGameViewModel({
      gameId: 'mock-game',
      displayName: 'Mock Game',
      capabilities: [capability('game.reset')],
    }, {
      gameId: 'mock-game',
      revision: 2,
      state: {
        player: { x: 2, y: 1, energy: 7, coins: 1 },
        coin: { x: 2, y: 1, collected: true },
      },
    })

    expect(view).toMatchObject({
      kind: 'mock',
      metrics: [
        { label: '位置', value: '2, 1' },
        { label: '体力', value: 7 },
        { label: '金币', value: 1 },
      ],
      map: { player: { x: 2, y: 1 }, coin: { x: 2, y: 1, collected: true } },
    })
  })

  it('renders Stardew farm, player, companion growth, and action status', () => {
    const view = buildGameViewModel({
      gameId: 'stardew-valley',
      displayName: 'Stardew Valley / 星露谷物语',
      capabilities: [capability('game.state', 'observation'), capability('stardew.water_all'), capability('stardew.clear_debris')],
    }, {
      gameId: 'stardew-valley',
      saveId: 'farm-a',
      revision: 3,
      state: {
        scene: {
          location: { id: 'Farm' },
          clock: { time: 930 },
          weather: { kind: 'sunny' },
        },
        player: {
          vitals: { health: { current: 80, max: 100 }, stamina: { current: 140, max: 270 } },
          currency: { money: 1234 },
        },
        companion: {
          growth: { form: 'farming', combat: 3, farming: 20, fishing: 5, threshold: 20 },
          stamina: { current: 12, max: 15 },
          flight: { airborne: false, transitioning: false },
          assists: { combatActive: false },
        },
        entities: [{ id: 'Abigail', kind: 'npc' }],
        extensions: { stardew: { farm: { tilled: 18, dry: 7, ripe: 4 } } },
      },
    })

    expect(view).toMatchObject({
      kind: 'stardew',
      title: '《星露谷物语》农场',
      metrics: [
        { label: '地点', value: 'Farm' },
        { label: '时间', value: '09:30' },
        { label: '小汤圆体力', value: '12 / 15' },
        { label: '动作能力', value: 2 },
      ],
    })
    expect(view.sections[0].items).toContainEqual({ label: '待浇水', value: 7 })
    expect(view.sections[2].items).toContainEqual({ label: '成长形态', value: '种植型' })
  })

  it('limits the generic raw-state preview and filters common secret fields', () => {
    const preview = safeStatePreview({
      apiKey: 'must-not-leak',
      inventory: Array.from({ length: 30 }, (_, index) => ({ index, description: 'x'.repeat(800) })),
    })

    expect(preview).not.toContain('must-not-leak')
    expect(preview).toContain('[已过滤]')
    expect(preview).toContain('其余 10 项')
    expect(preview.length).toBeLessThanOrEqual(8_020)
  })
})
