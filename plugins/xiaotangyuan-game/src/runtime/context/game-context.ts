import { createHash } from 'node:crypto'
import type { AdapterHello } from '../../protocol/game.js'

export const AI_NATIVE_GAME_CONTEXT_SCHEMA = 'ai-native.game-context.v1'

type JsonObject = Record<string, unknown>

export interface NormalizedGameContext {
  value: JsonObject
  migratedFrom?: string
  warnings: string[]
}

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const asString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const asBoolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined

function boundedString(value: unknown, maximum = 200): string | undefined {
  const text = asString(value)
  return text === undefined ? undefined : text.slice(0, maximum)
}

function compactObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function capturedAt(value: unknown, now: Date): string {
  const direct = asString(value)
  if (direct !== undefined && !Number.isNaN(Date.parse(direct))) return new Date(direct).toISOString()
  const unix = asNumber(value)
  if (unix !== undefined) return new Date(unix < 10_000_000_000 ? unix * 1_000 : unix).toISOString()
  return now.toISOString()
}

function ratio(current: unknown, maximum?: unknown): JsonObject | undefined {
  const currentNumber = asNumber(current)
  const maximumNumber = asNumber(maximum)
  if (currentNumber === undefined && maximumNumber === undefined) return undefined
  return compactObject({
    current: currentNumber,
    max: maximumNumber,
    ratio: currentNumber !== undefined && maximumNumber !== undefined && maximumNumber > 0
      ? Math.max(0, Math.min(1, currentNumber / maximumNumber))
      : maximumNumber === undefined && currentNumber !== undefined && currentNumber >= 0 && currentNumber <= 1
        ? currentNumber
        : undefined,
  })
}

function opaqueSaveScope(gameId: string, value: unknown): string | undefined {
  const raw = asString(value)
  if (raw === undefined) return undefined
  if (/^[a-f0-9]{64}$/i.test(raw)) return `sha256:${raw.toLowerCase()}`
  return `sha256:${createHash('sha256').update(`${gameId}:${raw}`).digest('hex')}`
}

function item(value: unknown): JsonObject | undefined {
  const source = asObject(value)
  if (source === undefined) return undefined
  const id = boundedString(source.id ?? source.prefab, 120)
  const name = boundedString(source.name ?? source.displayName ?? source.title, 120)
  if (id === undefined && name === undefined) return undefined
  return compactObject({
    id,
    name,
    count: asNumber(source.count ?? source.stack),
    equipped: asBoolean(source.equipped),
    slot: boundedString(source.slot, 60),
  })
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limited]'
  if (typeof value === 'string') return value.slice(0, 500)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map(entry => sanitize(entry, depth + 1))
  const source = asObject(value)
  if (source === undefined) return undefined
  const forbidden = /(?:password|passwd|secret|token|api.?key|credential|file.?path|save.?path|user.?name|steam.?id|account.?id)/i
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => !forbidden.test(key))
    .slice(0, 60)
    .map(([key, entry]) => [key.slice(0, 80), sanitize(entry, depth + 1)]))
}

function normalizeStandard(source: JsonObject, adapter: AdapterHello | undefined, now: Date): NormalizedGameContext {
  const warnings: string[] = []
  const meta = asObject(source.meta) ?? {}
  const declaredGameId = boundedString(meta.gameId, 100)
  const gameId = boundedString(adapter?.gameId ?? declaredGameId, 100) ?? 'unknown'
  if (asString(meta.gameId) === undefined) warnings.push('meta.gameId was supplied by the Adapter handshake')
  if (adapter?.gameId !== undefined && declaredGameId !== undefined && adapter.gameId !== declaredGameId) warnings.push('meta.gameId did not match the Adapter handshake')
  const saveScope = boundedString(meta.saveScope, 160)
  if (saveScope !== undefined && !/^sha256:[a-f0-9]{64}$/.test(saveScope)) warnings.push('meta.saveScope was removed because it was not an irreversible SHA-256 scope')
  const value = compactObject({
    schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
    meta: compactObject({
      gameId,
      adapterId: boundedString(meta.adapterId ?? adapter?.adapterId, 120),
      capturedAt: capturedAt(meta.capturedAt, now),
      sequence: asNumber(meta.sequence),
      saveScope: saveScope !== undefined && /^sha256:[a-f0-9]{64}$/.test(saveScope) ? saveScope : undefined,
      locale: boundedString(meta.locale, 30),
    }),
    scene: sanitize(asObject(source.scene) ?? {}),
    player: sanitize(asObject(source.player) ?? {}),
    companion: source.companion === undefined ? undefined : sanitize(asObject(source.companion) ?? {}),
    entities: sanitize(asArray(source.entities).slice(0, 40)),
    objectives: sanitize(asArray(source.objectives).slice(0, 20)),
    ui: sanitize(asObject(source.ui) ?? {}),
    extensions: source.extensions === undefined ? undefined : sanitize(asObject(source.extensions) ?? {}),
  })
  return { value, warnings }
}

function normalizeDst(source: JsonObject, adapter: AdapterHello | undefined, now: Date): NormalizedGameContext {
  const player = asObject(source.player) ?? {}
  const world = asObject(source.world) ?? {}
  const inventory = asObject(player.inventory) ?? {}
  const chester = asObject(source.chester) ?? {}
  const equipped = asArray(inventory.equipped).map(item).filter((value): value is JsonObject => value !== undefined)
  const items = [...asArray(inventory.items).map(item).filter((value): value is JsonObject => value !== undefined), ...equipped.map(value => ({ ...value, equipped: true }))].slice(0, 30)
  const active = item(inventory.active)
  if (active !== undefined) items.unshift({ ...active, equipped: true, slot: 'active' })
  const entities = asArray(source.nearby).map(entry => {
    const entity = asObject(entry) ?? {}
    return compactObject({
      id: boundedString(entity.prefab, 120),
      kind: 'entity',
      name: boundedString(entity.name ?? entity.prefab, 120),
      distance: asNumber(entity.distance),
    })
  }).sort((left, right) => (asNumber(left.distance) ?? Number.MAX_VALUE) - (asNumber(right.distance) ?? Number.MAX_VALUE)).slice(0, 30)
  return {
    migratedFrom: 'xty.dst.legacy',
    warnings: [],
    value: compactObject({
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: compactObject({
        gameId: adapter?.gameId ?? 'dont-starve-together',
        adapterId: adapter?.adapterId,
        capturedAt: capturedAt(source.captured_at_unix, now),
        saveScope: opaqueSaveScope('dont-starve-together', source.save_id),
      }),
      scene: {
        clock: compactObject({ day: asNumber(world.cycles) === undefined ? undefined : (asNumber(world.cycles) as number) + 1, phase: boundedString(world.phase), season: boundedString(world.season) }),
        weather: compactObject({ raining: asBoolean(world.is_raining), snowing: asBoolean(world.is_snowing), temperature: asNumber(world.temperature), temperatureUnit: 'game' }),
      },
      player: compactObject({
        id: boundedString(player.prefab, 120) ?? 'local-player',
        name: boundedString(player.name, 120),
        position: compactObject({ space: 'world', ...(asObject(player.position) ?? {}) }),
        vitals: compactObject({ health: ratio(player.health_percent), hunger: ratio(player.hunger_percent), sanity: ratio(player.sanity_percent), moisture: ratio(player.moisture_percent), temperature: ratio(player.temperature) }),
        inventory: { items },
      }),
      companion: compactObject({
        id: 'xiaotangyuan',
        present: asBoolean(chester.present) ?? false,
        distance: asNumber(chester.distance),
        position: compactObject({ space: 'world', ...(asObject(chester.position) ?? {}) }),
        vitals: compactObject({ health: ratio(chester.health_percent) }),
        state: [asBoolean(chester.is_dead) === true ? 'dead' : 'following'],
      }),
      entities,
      objectives: [],
      ui: {},
      extensions: {
        dst: compactObject({
          gameTimeSeconds: asNumber(source.game_time_seconds),
          remainingDaysInSeason: asNumber(world.remaining_days_in_season),
          moonPhase: boundedString(world.moon_phase),
          fullMoon: asBoolean(world.is_full_moon),
          companionVariant: boundedString(chester.variant),
          companionContainerSlots: asNumber(chester.container_slots),
          companionContainerOccupied: asNumber(chester.container_occupied),
        }),
      },
    }),
  }
}

function normalizeStardew(source: JsonObject, adapter: AdapterHello | undefined, now: Date): NormalizedGameContext {
  const game = asObject(source.game) ?? {}
  const player = asObject(source.player) ?? {}
  const location = asObject(source.location) ?? {}
  const inventory = asArray(player.inventory).map(item).filter((value): value is JsonObject => value !== undefined).slice(0, 30)
  const npcs = asArray(location.nearbyNpcs).map(entry => {
    const npc = asObject(entry) ?? {}
    return compactObject({ id: boundedString(npc.name, 120), kind: 'npc', name: boundedString(npc.name, 120), position: compactObject({ space: 'tile', ...(asObject(npc.tile) ?? {}) }), relationshipLevel: asNumber(npc.hearts) })
  })
  const monsters = asArray(location.monsters).map(entry => {
    const monster = asObject(entry) ?? {}
    return compactObject({ id: boundedString(monster.name, 120), kind: 'creature', name: boundedString(monster.name, 120), hostile: true, distance: asNumber(monster.distance), vitals: compactObject({ health: ratio(monster.health) }) })
  })
  return {
    migratedFrom: boundedString(source.schema) ?? 'xty.stardew.legacy',
    warnings: [],
    value: {
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: compactObject({ gameId: adapter?.gameId ?? 'stardew-valley', adapterId: adapter?.adapterId, capturedAt: capturedAt(source.capturedAt, now) }),
      scene: {
        location: compactObject({ id: boundedString(location.id), kind: boundedString(location.type), outdoors: asBoolean(location.outdoors) }),
        clock: compactObject({ year: asNumber(game.year), season: boundedString(game.season), day: asNumber(game.day), time: asNumber(game.time) }),
        weather: compactObject({ kind: boundedString(game.weather) }),
      },
      player: compactObject({
        id: 'local-player', name: boundedString(player.name), position: compactObject({ space: 'tile', ...(asObject(player.tile) ?? {}) }),
        vitals: compactObject({ health: ratio(player.health, player.maxHealth), stamina: ratio(player.stamina, player.maxStamina) }),
        inventory: compactObject({ items: inventory, freeSlots: asNumber(player.inventoryFreeSlots), activeItem: boundedString(player.currentItem) }),
        currency: compactObject({ money: asNumber(player.money) }),
      }),
      companion: source.companionGrowth === undefined ? undefined : compactObject({ id: 'xiaotangyuan', present: true, growth: sanitize(source.companionGrowth) }),
      entities: [...npcs, ...monsters].slice(0, 30),
      objectives: asArray(source.quests).slice(0, 20).map(entry => sanitize(entry)),
      ui: sanitize(asObject(source.ui) ?? {}),
      extensions: { stardew: compactObject({ farm: sanitize(asObject(source.farm) ?? {}), objectCount: asNumber(location.objects) }) },
    },
  }
}

function normalizeOni(source: JsonObject, adapter: AdapterHello | undefined, now: Date): NormalizedGameContext {
  const cursor = asObject(source.cursor) ?? {}
  const duplicants = asArray(source.duplicants).map(entry => {
    const actor = asObject(entry) ?? {}
    return compactObject({
      id: asNumber(actor.id), kind: 'character', name: boundedString(actor.name), selected: asBoolean(actor.selected),
      position: compactObject({ space: 'cell', cell: asNumber(actor.cell) }),
      reachableFromCursor: asBoolean(actor.canReachCursor),
    })
  }).slice(0, 30)
  return {
    migratedFrom: 'xty.oni.legacy',
    warnings: [],
    value: {
      schema: AI_NATIVE_GAME_CONTEXT_SCHEMA,
      meta: compactObject({ gameId: adapter?.gameId ?? 'oxygen-not-included', adapterId: adapter?.adapterId, capturedAt: now.toISOString() }),
      scene: {},
      player: compactObject({ id: asNumber(source.selectedDuplicantId), position: compactObject({ space: 'cell', cell: asNumber(cursor.cell) }) }),
      entities: duplicants,
      objectives: [],
      ui: { cursor: compactObject({ space: 'cell', cell: asNumber(cursor.cell), element: boundedString(cursor.element), solid: asBoolean(cursor.solid) }) },
      extensions: { oni: compactObject({ summary: boundedString(source.summary, 4_000), selectedDuplicantId: asNumber(source.selectedDuplicantId) }) },
    },
  }
}

export function normalizeGameContext(observation: unknown, adapter?: AdapterHello, now = new Date()): NormalizedGameContext {
  const source = asObject(observation) ?? {}
  if (source.schema === AI_NATIVE_GAME_CONTEXT_SCHEMA) return normalizeStandard(source, adapter, now)
  const gameId = adapter?.gameId
  if (gameId === 'dont-starve-together' || source.world !== undefined || source.chester !== undefined) return normalizeDst(source, adapter, now)
  if (gameId === 'stardew-valley' || asString(source.schema)?.startsWith('xty.stardew.') === true) return normalizeStardew(source, adapter, now)
  if (gameId === 'oxygen-not-included' || source.duplicants !== undefined || source.cursor !== undefined) return normalizeOni(source, adapter, now)
  return normalizeStandard({ schema: AI_NATIVE_GAME_CONTEXT_SCHEMA, meta: { gameId }, extensions: { legacy: sanitize(source) } }, adapter, now)
}

export function renderGameContextForPrompt(observation: unknown, adapter?: AdapterHello, now = new Date()): string | undefined {
  if (observation === undefined) return undefined
  const normalized = normalizeGameContext(observation, adapter, now)
  let value = normalized.value
  const meta = asObject(value.meta) ?? {}
  const observedAt = Date.parse(asString(meta.capturedAt) ?? '')
  const ageMs = Number.isFinite(observedAt) ? Math.max(0, now.getTime() - observedAt) : 0
  if (ageMs > 30_000) return undefined
  if (ageMs > 5_000) value = { ...value, meta: { ...meta, stale: true } }
  let encoded = JSON.stringify(value)
  if (encoded.length > 12_000) {
    value = { ...value, extensions: { truncated: true } }
    encoded = JSON.stringify(value)
  }
  if (encoded.length > 12_000) {
    const entities = asArray(value.entities).slice(0, 12)
    value = { ...value, entities, extensions: { truncated: true } }
    encoded = JSON.stringify(value)
  }
  return encoded
}
