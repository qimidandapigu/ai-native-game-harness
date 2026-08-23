import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ResolvedConfig } from '../../config.js'
import type {
  GameMemoryCandidate,
  EditableSharedField,
  GamePlayStatistics,
  MemoryIdentity,
  PlayStatistics,
  RememberedGameEvent,
  SharedProfile,
  SharedProfilePatch,
} from './contracts.js'

const EMPTY_PROFILE: SharedProfile = {
  interests: [],
  playStyles: [],
  playedGames: [],
  companionTraits: [],
}

function uniqueStrings(values: readonly string[], maximum = 24): string[] {
  const output: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim().slice(0, 80)
    const key = value.toLocaleLowerCase()
    if (value === '' || seen.has(key)) continue
    seen.add(key)
    output.push(value)
    if (output.length >= maximum) break
  }
  return output
}

function parseProfile(raw: unknown): SharedProfile {
  if (typeof raw !== 'string') return structuredClone(EMPTY_PROFILE)
  try {
    const value = JSON.parse(raw) as Partial<SharedProfile>
    return {
      ...(typeof value.preferredName === 'string' ? { preferredName: value.preferredName.slice(0, 80) } : {}),
      ...(typeof value.language === 'string' ? { language: value.language.slice(0, 40) } : {}),
      ...(typeof value.responseStyle === 'string' ? { responseStyle: value.responseStyle.slice(0, 120) } : {}),
      interests: uniqueStrings(Array.isArray(value.interests) ? value.interests.filter(item => typeof item === 'string') : []),
      playStyles: uniqueStrings(Array.isArray(value.playStyles) ? value.playStyles.filter(item => typeof item === 'string') : []),
      playedGames: uniqueStrings(Array.isArray(value.playedGames) ? value.playedGames.filter(item => typeof item === 'string') : []),
      ...(typeof value.companionName === 'string' ? { companionName: value.companionName.slice(0, 80) } : {}),
      companionTraits: uniqueStrings(Array.isArray(value.companionTraits) ? value.companionTraits.filter(item => typeof item === 'string') : []),
    }
  } catch {
    return structuredClone(EMPTY_PROFILE)
  }
}

function dedupeKey(candidate: GameMemoryCandidate): string {
  return `${candidate.kind}:${candidate.subject.trim().toLocaleLowerCase().replace(/\s+/g, ' ')}`.slice(0, 220)
}

function queryTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ')
  const words = normalized.split(/\s+/).filter(item => item.length >= 2)
  const chinese = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(match => {
    const value = match[0]
    return [value, ...Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2))]
  })
  return uniqueStrings([...words, ...chinese], 24)
}

function eventScore(event: RememberedGameEvent, terms: readonly string[], now: number): number {
  const haystack = `${event.subject}\n${event.summary}`.toLocaleLowerCase()
  const relevance = terms.reduce((score, term) => score + (haystack.includes(term) ? 4 : 0), 0)
  const ageDays = Math.max(0, (now - event.updatedAt) / 86_400_000)
  const recency = Math.max(0, 4 - Math.log2(ageDays + 1))
  return relevance + event.importance * 2 + recency
}

function profileLines(profile: SharedProfile): string[] {
  return [
    profile.preferredName === undefined ? undefined : `Preferred name: ${profile.preferredName}`,
    profile.language === undefined ? undefined : `Language: ${profile.language}`,
    profile.responseStyle === undefined ? undefined : `Response style: ${profile.responseStyle}`,
    profile.interests.length === 0 ? undefined : `Interests: ${profile.interests.join(', ')}`,
    profile.playStyles.length === 0 ? undefined : `Play styles: ${profile.playStyles.join(', ')}`,
    profile.playedGames.length === 0 ? undefined : `Games played together: ${profile.playedGames.join(', ')}`,
    profile.companionName === undefined ? undefined : `Companion name: ${profile.companionName}`,
    profile.companionTraits.length === 0 ? undefined : `Companion traits: ${profile.companionTraits.join(', ')}`,
  ].filter((line): line is string => line !== undefined)
}

interface EventRow {
  id: string
  game_id: string
  save_id: string
  kind: GameMemoryCandidate['kind']
  subject: string
  summary: string
  importance: number
  status: RememberedGameEvent['status']
  created_at: number
  updated_at: number
}

function rowToEvent(row: EventRow): RememberedGameEvent {
  return {
    id: row.id,
    gameId: row.game_id,
    saveId: row.save_id,
    kind: row.kind,
    subject: row.subject,
    summary: row.summary,
    importance: row.importance,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class MemoryStore {
  readonly databasePath: string
  private readonly db: DatabaseSync

  constructor(private readonly config: ResolvedConfig['memory']) {
    mkdirSync(config.directory, { recursive: true })
    this.databasePath = join(config.directory, 'memory-v1.sqlite')
    this.db = new DatabaseSync(this.databasePath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS shared_profile (
        profile_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_memory (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        save_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        summary TEXT NOT NULL,
        importance INTEGER NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source_interaction_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(profile_id, game_id, save_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS game_memory_scope
        ON game_memory(profile_id, game_id, save_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS play_session (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        save_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ended_at INTEGER,
        active_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS play_session_scope
        ON play_session(profile_id, game_id, save_id, last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS play_day (
        profile_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        save_id TEXT NOT NULL,
        local_day TEXT NOT NULL,
        PRIMARY KEY(profile_id, game_id, save_id, local_day)
      );
    `)
  }

  getSharedProfile(): SharedProfile {
    const row = this.db.prepare('SELECT data_json FROM shared_profile WHERE profile_id = ?').get(this.config.profileId) as { data_json?: unknown } | undefined
    return parseProfile(row?.data_json)
  }

  updateSharedProfile(patch: SharedProfilePatch): SharedProfile {
    const current = this.getSharedProfile()
    const next: SharedProfile = {
      ...current,
      ...(patch.preferredName === undefined ? {} : { preferredName: patch.preferredName.slice(0, 80) }),
      ...(patch.language === undefined ? {} : { language: patch.language.slice(0, 40) }),
      ...(patch.responseStyle === undefined ? {} : { responseStyle: patch.responseStyle.slice(0, 120) }),
      interests: uniqueStrings([...current.interests, ...(patch.interests ?? [])]),
      playStyles: uniqueStrings([...current.playStyles, ...(patch.playStyles ?? [])]),
      ...(patch.companionName === undefined ? {} : { companionName: patch.companionName.slice(0, 80) }),
      companionTraits: uniqueStrings([...current.companionTraits, ...(patch.companionTraits ?? [])]),
    }
    this.writeProfile(next)
    return next
  }

  replaceSharedField(field: EditableSharedField, value: string | readonly string[] | undefined): SharedProfile {
    const current = this.getSharedProfile()
    const next = { ...current }
    if (field === 'interests' || field === 'playStyles' || field === 'companionTraits') {
      next[field] = uniqueStrings(Array.isArray(value) ? value : value === undefined ? [] : [value])
    } else if (typeof value !== 'string' || value.trim() === '') {
      delete next[field]
    } else {
      next[field] = value.trim().slice(0, field === 'responseStyle' ? 120 : 80)
    }
    this.writeProfile(next)
    return next
  }

  recordPlayedGame(gameId: string): void {
    const current = this.getSharedProfile()
    const playedGames = uniqueStrings([...current.playedGames, gameId])
    if (playedGames.length === current.playedGames.length) return
    this.writeProfile({ ...current, playedGames })
  }

  private writeProfile(profile: SharedProfile): void {
    this.db.prepare(`
      INSERT INTO shared_profile(profile_id, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(this.config.profileId, JSON.stringify(profile), Date.now())
  }

  remember(identity: MemoryIdentity, candidates: readonly GameMemoryCandidate[], sourceInteractionId: string): void {
    if (candidates.length === 0) return
    const now = Date.now()
    const statement = this.db.prepare(`
      INSERT INTO game_memory(
        id, profile_id, game_id, save_id, kind, subject, summary, importance,
        status, dedupe_key, source_interaction_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT(profile_id, game_id, save_id, dedupe_key) DO UPDATE SET
        summary = excluded.summary,
        importance = MAX(game_memory.importance, excluded.importance),
        status = 'active',
        source_interaction_id = excluded.source_interaction_id,
        updated_at = excluded.updated_at
    `)
    for (const candidate of candidates.slice(0, 2)) {
      statement.run(
        randomUUID(), this.config.profileId, identity.gameId, identity.saveId,
        candidate.kind, candidate.subject, candidate.summary, candidate.importance,
        dedupeKey(candidate), sourceInteractionId, now, now,
      )
    }
    this.prune(identity)
  }

  listGameMemory(identity: MemoryIdentity, limit = 300): RememberedGameEvent[] {
    const rows = this.db.prepare(`
      SELECT id, game_id, save_id, kind, subject, summary, importance, status, created_at, updated_at
      FROM game_memory
      WHERE profile_id = ? AND game_id = ? AND save_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(this.config.profileId, identity.gameId, identity.saveId, limit) as unknown as EventRow[]
    return rows.map(rowToEvent)
  }

  listAllGameMemory(limit = 500): RememberedGameEvent[] {
    const rows = this.db.prepare(`
      SELECT id, game_id, save_id, kind, subject, summary, importance, status, created_at, updated_at
      FROM game_memory
      WHERE profile_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(this.config.profileId, limit) as unknown as EventRow[]
    return rows.map(rowToEvent)
  }

  deleteGameMemory(id: string): boolean {
    return this.db.prepare('DELETE FROM game_memory WHERE profile_id = ? AND id = ?')
      .run(this.config.profileId, id).changes > 0
  }

  beginPlaySession(id: string, identity: MemoryIdentity, now = Date.now()): void {
    this.recordPlayedGame(identity.gameId)
    this.db.prepare(`
      INSERT OR IGNORE INTO play_session(id, profile_id, game_id, save_id, started_at, last_seen_at, active_ms)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(id, this.config.profileId, identity.gameId, identity.saveId, now, now)
    this.recordPlayDay(identity, now)
  }

  touchPlaySession(id: string, identity: MemoryIdentity, now = Date.now()): void {
    const row = this.db.prepare(`
      SELECT last_seen_at FROM play_session
      WHERE id = ? AND profile_id = ? AND game_id = ? AND save_id = ?
    `).get(id, this.config.profileId, identity.gameId, identity.saveId) as { last_seen_at?: unknown } | undefined
    if (typeof row?.last_seen_at !== 'number') {
      this.beginPlaySession(id, identity, now)
      return
    }
    const activeDelta = Math.min(120_000, Math.max(0, now - row.last_seen_at))
    this.db.prepare(`
      UPDATE play_session
      SET last_seen_at = ?, active_ms = active_ms + ?
      WHERE id = ? AND profile_id = ?
    `).run(now, activeDelta, id, this.config.profileId)
    this.recordPlayDay(identity, now)
  }

  endPlaySession(id: string, identity: MemoryIdentity, now = Date.now()): void {
    this.touchPlaySession(id, identity, now)
    this.db.prepare('UPDATE play_session SET ended_at = ? WHERE id = ? AND profile_id = ?')
      .run(now, id, this.config.profileId)
  }

  listPlayStatistics(): PlayStatistics[] {
    const sessionRows = this.db.prepare(`
      SELECT game_id, save_id, COUNT(*) AS session_count, SUM(active_ms) AS active_ms, MAX(last_seen_at) AS last_played_at
      FROM play_session WHERE profile_id = ? GROUP BY game_id, save_id
    `).all(this.config.profileId) as unknown as Array<Record<string, unknown>>
    const dayRows = this.db.prepare(`
      SELECT game_id, save_id, COUNT(*) AS play_days
      FROM play_day WHERE profile_id = ? GROUP BY game_id, save_id
    `).all(this.config.profileId) as unknown as Array<Record<string, unknown>>
    const memoryRows = this.db.prepare(`
      SELECT game_id, save_id, COUNT(*) AS memory_count
      FROM game_memory WHERE profile_id = ? AND status = 'active' GROUP BY game_id, save_id
    `).all(this.config.profileId) as unknown as Array<Record<string, unknown>>
    const key = (row: Record<string, unknown>): string => `${String(row.game_id)}\u0000${String(row.save_id)}`
    const days = new Map(dayRows.map(row => [key(row), Number(row.play_days)]))
    const memories = new Map(memoryRows.map(row => [key(row), Number(row.memory_count)]))
    return sessionRows.map(row => ({
      gameId: String(row.game_id),
      saveId: String(row.save_id),
      sessionCount: Number(row.session_count),
      playDays: days.get(key(row)) ?? 0,
      activeMs: Number(row.active_ms),
      lastPlayedAt: Number(row.last_played_at),
      memoryCount: memories.get(key(row)) ?? 0,
    })).sort((left, right) => right.lastPlayedAt - left.lastPlayedAt)
  }

  listGamePlayStatistics(): GamePlayStatistics[] {
    const sessionRows = this.db.prepare(`
      SELECT game_id, COUNT(DISTINCT save_id) AS save_count, COUNT(*) AS session_count,
             SUM(active_ms) AS active_ms, MAX(last_seen_at) AS last_played_at
      FROM play_session WHERE profile_id = ? GROUP BY game_id
    `).all(this.config.profileId) as unknown as Array<Record<string, unknown>>
    const dayRows = this.db.prepare(`
      SELECT game_id, COUNT(DISTINCT local_day) AS play_days
      FROM play_day WHERE profile_id = ? GROUP BY game_id
    `).all(this.config.profileId) as unknown as Array<Record<string, unknown>>
    const days = new Map(dayRows.map(row => [String(row.game_id), Number(row.play_days)]))
    return sessionRows.map(row => ({
      gameId: String(row.game_id),
      saveCount: Number(row.save_count),
      sessionCount: Number(row.session_count),
      playDays: days.get(String(row.game_id)) ?? 0,
      activeMs: Number(row.active_ms),
      lastPlayedAt: Number(row.last_played_at),
    })).sort((left, right) => right.lastPlayedAt - left.lastPlayedAt)
  }

  private recordPlayDay(identity: MemoryIdentity, now: number): void {
    const date = new Date(now)
    const localDay = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
    this.db.prepare(`
      INSERT OR IGNORE INTO play_day(profile_id, game_id, save_id, local_day)
      VALUES (?, ?, ?, ?)
    `).run(this.config.profileId, identity.gameId, identity.saveId, localDay)
  }

  recall(identity: MemoryIdentity, query: string): string | undefined {
    const profile = this.getSharedProfile()
    const active = this.listGameMemory(identity, 100).filter(event => event.status === 'active')
    const terms = queryTerms(query)
    const now = Date.now()
    const goals = active.filter(event => event.kind === 'goal').sort((left, right) => eventScore(right, terms, now) - eventScore(left, terms, now)).slice(0, 2)
    const selectedIds = new Set(goals.map(event => event.id))
    const relevant = active
      .filter(event => !selectedIds.has(event.id))
      .sort((left, right) => eventScore(right, terms, now) - eventScore(left, terms, now))
      .slice(0, 3)
    const lines = profileLines(profile)
    const events = [...goals, ...relevant]
    if (lines.length === 0 && events.length === 0) return undefined
    const sections = [
      lines.length === 0 ? undefined : `Shared player profile:\n${lines.map(line => `- ${line}`).join('\n')}`,
      events.length === 0
        ? undefined
        : `Current game/save memories:\n${events.map(event => `- [${event.kind}] ${event.summary}`).join('\n')}`,
    ].filter((section): section is string => section !== undefined)
    return sections.join('\n\n').slice(0, 1_200)
  }

  clearSharedProfile(): void {
    this.db.prepare('DELETE FROM shared_profile WHERE profile_id = ?').run(this.config.profileId)
  }

  clearGameMemory(identity: MemoryIdentity): void {
    this.db.prepare('DELETE FROM game_memory WHERE profile_id = ? AND game_id = ? AND save_id = ?')
      .run(this.config.profileId, identity.gameId, identity.saveId)
  }

  clearAllGameMemory(): void {
    this.db.prepare('DELETE FROM game_memory WHERE profile_id = ?').run(this.config.profileId)
  }

  clearPlayStatistics(identity?: MemoryIdentity): void {
    if (identity === undefined) {
      this.db.prepare('DELETE FROM play_session WHERE profile_id = ?').run(this.config.profileId)
      this.db.prepare('DELETE FROM play_day WHERE profile_id = ?').run(this.config.profileId)
      return
    }
    this.db.prepare('DELETE FROM play_session WHERE profile_id = ? AND game_id = ? AND save_id = ?')
      .run(this.config.profileId, identity.gameId, identity.saveId)
    this.db.prepare('DELETE FROM play_day WHERE profile_id = ? AND game_id = ? AND save_id = ?')
      .run(this.config.profileId, identity.gameId, identity.saveId)
  }

  private prune(identity: MemoryIdentity): void {
    this.db.prepare(`
      DELETE FROM game_memory
      WHERE id IN (
        SELECT id FROM game_memory
        WHERE profile_id = ? AND game_id = ? AND save_id = ? AND importance < 5
        ORDER BY importance ASC, updated_at ASC
        LIMIT MAX(0, (
          SELECT COUNT(*) - ? FROM game_memory
          WHERE profile_id = ? AND game_id = ? AND save_id = ?
        ))
      )
    `).run(
      this.config.profileId, identity.gameId, identity.saveId, this.config.maxGameEntries,
      this.config.profileId, identity.gameId, identity.saveId,
    )
  }

  close(): void {
    this.db.close()
  }
}
