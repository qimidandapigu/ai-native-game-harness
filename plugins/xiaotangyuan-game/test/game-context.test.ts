import { describe, expect, it } from 'vitest'
import { normalizeGameContext, renderGameContextForPrompt, AI_NATIVE_GAME_CONTEXT_SCHEMA } from '../src/runtime/context/game-context.js'

const adapter = (gameId: string) => ({ adapterId: `test.${gameId}`, gameId, version: '1', protocolVersion: '1.1' })
const now = new Date('2026-08-20T00:00:00.000Z')

describe('AI-Native Game Context v1', () => {
  it('normalizes legacy DST state and removes the raw save identity', () => {
    const result = normalizeGameContext({
      save_id: 'private-session-value', captured_at_unix: 1_755_648_000,
      world: { cycles: 3, phase: 'day', season: 'autumn', is_raining: true },
      player: { name: 'Wilson', health_percent: 0.8, inventory: { items: [{ prefab: 'log', name: '木头', stack: 12 }] } },
      chester: { present: true, distance: 2.3 },
      nearby: [{ prefab: 'spider', distance: 6.1 }, { prefab: 'grass', distance: 1.2 }],
    }, adapter('dont-starve-together'), now)
    expect(result.value.schema).toBe(AI_NATIVE_GAME_CONTEXT_SCHEMA)
    expect(result.value.meta).toMatchObject({ gameId: 'dont-starve-together' })
    expect(JSON.stringify(result.value)).not.toContain('private-session-value')
    expect((result.value.entities as Array<{ id: string }>).map(entity => entity.id)).toEqual(['grass', 'spider'])
  })

  it('normalizes Stardew vitals, entities, objectives, and extensions', () => {
    const result = normalizeGameContext({
      schema: 'xty.stardew.observation.v1', capturedAt: '2026-08-20T01:00:00Z',
      game: { year: 1, season: 'spring', day: 2, time: 630, weather: 'sunny' },
      player: { name: 'Farmer', health: 75, maxHealth: 100, stamina: 135, maxStamina: 270, inventory: [{ name: 'Parsnip', count: 3 }] },
      location: { id: 'Farm', nearbyNpcs: [{ name: 'Abigail', hearts: 2 }], monsters: [] },
      farm: { ripe: 4 }, quests: [{ id: 'q1', title: 'Introductions' }], ui: { playerFree: true },
    }, adapter('stardew-valley'), now)
    const player = result.value.player as Record<string, unknown>
    expect((player.vitals as Record<string, unknown>).health).toMatchObject({ current: 75, max: 100, ratio: 0.75 })
    expect(result.value.entities).toHaveLength(1)
    expect(result.value.objectives).toHaveLength(1)
  })

  it('normalizes ONI cursor and duplicants', () => {
    const result = normalizeGameContext({
      summary: 'Cycle 12, oxygen stable', cursor: { cell: 42, element: 'Water', solid: false }, selectedDuplicantId: 7,
      duplicants: [{ id: 7, name: 'Ada', cell: 41, selected: true, canReachCursor: true }],
    }, adapter('oxygen-not-included'), now)
    expect(result.value.schema).toBe(AI_NATIVE_GAME_CONTEXT_SCHEMA)
    expect(result.value.entities).toEqual([expect.objectContaining({ id: 7, name: 'Ada', kind: 'character' })])
    expect(JSON.stringify(result.value)).toContain('oxygen stable')
  })

  it('renders bounded JSON for the model', () => {
    const encoded = renderGameContextForPrompt({
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: { gameId: 'test', capturedAt: now.toISOString() },
      entities: Array.from({ length: 100 }, (_, index) => ({ id: `entity-${index}`, description: 'x'.repeat(1_000) })),
    }, adapter('test'), now)
    expect(encoded).toBeDefined()
    expect(encoded!.length).toBeLessThanOrEqual(12_000)
    expect(JSON.parse(encoded!).schema).toBe(AI_NATIVE_GAME_CONTEXT_SCHEMA)
  })

  it('marks slightly old state stale and rejects expired state', () => {
    const state = {
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: { gameId: 'test', capturedAt: '2026-08-20T00:00:00.000Z' },
      scene: {}, player: {}, entities: [], objectives: [], ui: {},
    }
    const stale = renderGameContextForPrompt(state, adapter('test'), new Date('2026-08-20T00:00:06.000Z'))
    expect(JSON.parse(stale!).meta.stale).toBe(true)
    expect(renderGameContextForPrompt(state, adapter('test'), new Date('2026-08-20T00:00:31.000Z'))).toBeUndefined()
  })

  it('trusts the authenticated Adapter game id over observation metadata', () => {
    const result = normalizeGameContext({
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: { gameId: 'spoofed-game', capturedAt: now.toISOString(), saveScope: 'raw-save-name' },
      scene: {}, player: {}, entities: [], objectives: [], ui: {},
    }, adapter('stardew-valley'), now)
    expect((result.value.meta as Record<string, unknown>).gameId).toBe('stardew-valley')
    expect((result.value.meta as Record<string, unknown>).saveScope).toBeUndefined()
    expect(result.warnings).toHaveLength(2)
  })

  it('removes credential and local path fields from standard extensions', () => {
    const result = normalizeGameContext({
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: { gameId: 'test', capturedAt: now.toISOString() },
      scene: {}, player: {}, entities: [], objectives: [], ui: {},
      extensions: { test: { apiKey: 'never-send', savePath: 'C:/private/save', usefulFact: 'day 3' } },
    }, adapter('test'), now)
    const encoded = JSON.stringify(result.value)
    expect(encoded).toContain('day 3')
    expect(encoded).not.toContain('never-send')
    expect(encoded).not.toContain('C:/private/save')
  })
})
