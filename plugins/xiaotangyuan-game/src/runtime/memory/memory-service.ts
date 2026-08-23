import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AdapterHello, GameChatRequest } from '../../protocol/game.js'
import type { ResolvedConfig } from '../../config.js'
import {
  GAME_MEMORY_KINDS,
  resolveExplicitMemoryIdentity,
  resolveMemoryIdentity,
  type GameMemoryCandidate,
  type MemoryIdentity,
  type MemoryExtraction,
  type SharedProfilePatch,
} from './contracts.js'
import { MemoryStore } from './memory-store.js'

const EXTRACTION_SYSTEM_PROMPT = `You extract durable memory for a local game companion.
Return exactly one JSON object and no markdown.
Schema:
{"shared":{"preferredName"?:string,"language"?:string,"responseStyle"?:string,"interests"?:string[],"playStyles"?:string[],"companionName"?:string,"companionTraits"?:string[]}|null,"gameMemories":[{"kind":"goal"|"preference"|"relationship"|"decision"|"milestone"|"promise","subject":string,"summary":string,"importance":1|2|3|4|5}]}
Rules:
- shared is only for low-risk facts clearly about the real player across games: directly expressed interests, play styles, communication preferences, preferred name, language, or companion identity.
- Never infer sensitive traits, health, politics, religion, sexuality, finances, negative personality labels, or role-play as real-player profile.
- A fact true only in this game/save belongs in gameMemories, never shared.
- Do not store ordinary chatter, raw game state, transient conditions, secrets, paths, account IDs, or facts recoverable from the current screenshot/state.
- Prefer no memory over an uncertain memory. At most one shared change and two game memories.
- Each string must be concise; game summary <= 160 characters.`

const SESSION_SUMMARY_SYSTEM_PROMPT = `You consolidate one completed game play session into durable game/save memories.
Return exactly one JSON object and no markdown:
{"shared":null,"gameMemories":[{"kind":"goal"|"preference"|"relationship"|"decision"|"milestone"|"promise","subject":string,"summary":string,"importance":1|2|3|4|5}]}
Keep at most two items. Preserve only unfinished goals, explicit decisions, promises, relationship changes, or meaningful milestones.
Do not save ordinary chatter, current status, screenshots, secrets, paths, account IDs, or facts that can be read from the game again.
Prefer an empty gameMemories array over uncertain or duplicate memories.`

interface ActivePlaySession {
  storageId: string
  adapter: AdapterHello
  identity?: MemoryIdentity
  lastPersistedAt: number
  transcript: string[]
  selection?: ModelSelection
}

function sameIdentity(left: MemoryIdentity | undefined, right: MemoryIdentity | undefined): boolean {
  return left?.gameId === right?.gameId && left?.saveId === right?.saveId
}

function cleanString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().replace(/\s+/g, ' ')
  return cleaned === '' ? undefined : cleaned.slice(0, maximum)
}

function stringList(value: unknown, maximumItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const output = value
    .map(item => cleanString(item, 80))
    .filter((item): item is string => item !== undefined)
    .slice(0, maximumItems)
  return output.length === 0 ? undefined : output
}

function parseShared(value: unknown): SharedProfilePatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const patch: SharedProfilePatch = {
    ...(cleanString(source.preferredName, 80) === undefined ? {} : { preferredName: cleanString(source.preferredName, 80) }),
    ...(cleanString(source.language, 40) === undefined ? {} : { language: cleanString(source.language, 40) }),
    ...(cleanString(source.responseStyle, 120) === undefined ? {} : { responseStyle: cleanString(source.responseStyle, 120) }),
    ...(stringList(source.interests, 3) === undefined ? {} : { interests: stringList(source.interests, 3) }),
    ...(stringList(source.playStyles, 3) === undefined ? {} : { playStyles: stringList(source.playStyles, 3) }),
    ...(cleanString(source.companionName, 80) === undefined ? {} : { companionName: cleanString(source.companionName, 80) }),
    ...(stringList(source.companionTraits, 3) === undefined ? {} : { companionTraits: stringList(source.companionTraits, 3) }),
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

function parseGameMemory(value: unknown): GameMemoryCandidate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.kind !== 'string' || !GAME_MEMORY_KINDS.includes(source.kind as GameMemoryCandidate['kind'])) return undefined
  const subject = cleanString(source.subject, 80)
  const summary = cleanString(source.summary, 160)
  const importance = typeof source.importance === 'number' ? Math.round(source.importance) : 0
  if (subject === undefined || summary === undefined || importance < 1 || importance > 5) return undefined
  return { kind: source.kind as GameMemoryCandidate['kind'], subject, summary, importance }
}

export function parseMemoryExtraction(text: string): MemoryExtraction {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (candidate.trim() === '') return { gameMemories: [] }
  try {
    const value = JSON.parse(candidate) as Record<string, unknown>
    const shared = parseShared(value.shared)
    const gameMemories = Array.isArray(value.gameMemories)
      ? value.gameMemories.map(parseGameMemory).filter((item): item is GameMemoryCandidate => item !== undefined).slice(0, 2)
      : []
    return { ...(shared === undefined ? {} : { shared }), gameMemories }
  } catch {
    return { gameMemories: [] }
  }
}

function extractionInput(adapter: AdapterHello, request: GameChatRequest, reply: string): string {
  return [
    `Game: ${adapter.gameId}`,
    `Player message: ${request.text.slice(0, 2_000)}`,
    `Companion final reply: ${reply.slice(0, 2_000)}`,
  ].join('\n')
}

export class MemoryService {
  readonly store: MemoryStore
  private learningQueue: Promise<void> = Promise.resolve()
  private readonly playSessions = new Map<string, ActivePlaySession>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig['memory'],
  ) {
    this.store = new MemoryStore(config)
  }

  adapterConnected(sessionKey: string, adapter: AdapterHello): void {
    if (!this.config.enabled) return
    this.store.recordPlayedGame(adapter.gameId)
    const active: ActivePlaySession = {
      storageId: randomUUID(),
      adapter,
      identity: resolveExplicitMemoryIdentity(adapter),
      lastPersistedAt: Date.now(),
      transcript: [],
    }
    this.playSessions.set(sessionKey, active)
    if (active.identity !== undefined) this.store.beginPlaySession(active.storageId, active.identity, active.lastPersistedAt)
  }

  observeSession(sessionKey: string, adapter: AdapterHello | undefined, request?: GameChatRequest): void {
    if (!this.config.enabled || adapter === undefined || this.closing) return
    let active = this.playSessions.get(sessionKey)
    if (active === undefined) {
      this.adapterConnected(sessionKey, adapter)
      active = this.playSessions.get(sessionKey)
    }
    if (active === undefined) return
    const identity = resolveExplicitMemoryIdentity(adapter, request)
    if (identity !== undefined && !sameIdentity(active.identity, identity)) {
      this.finishActiveSession(active, Date.now())
      active = {
        storageId: randomUUID(), adapter, identity, lastPersistedAt: Date.now(), transcript: [],
      }
      this.playSessions.set(sessionKey, active)
      this.store.beginPlaySession(active.storageId, identity, active.lastPersistedAt)
      return
    }
    if (active.identity === undefined || Date.now() - active.lastPersistedAt < 15_000) return
    active.lastPersistedAt = Date.now()
    this.store.touchPlaySession(active.storageId, active.identity, active.lastPersistedAt)
  }

  recall(adapter: AdapterHello | undefined, request: GameChatRequest): string | undefined {
    if (!this.config.enabled) return undefined
    const identity = resolveMemoryIdentity(adapter, request)
    return identity === undefined ? undefined : this.store.recall(identity, request.text)
  }

  activeIdentities(): MemoryIdentity[] {
    const unique = new Map<string, MemoryIdentity>()
    for (const active of this.playSessions.values()) {
      if (active.identity !== undefined) unique.set(`${active.identity.gameId}\u0000${active.identity.saveId}`, active.identity)
    }
    return [...unique.values()]
  }

  scheduleLearn(
    sessionKey: string,
    adapter: AdapterHello | undefined,
    request: GameChatRequest,
    reply: string,
    interactionId: string,
    selection: ModelSelection,
  ): void {
    if (!this.config.enabled || !this.config.autoLearn || this.closing || adapter === undefined) return
    this.observeSession(sessionKey, adapter, request)
    const identity = resolveMemoryIdentity(adapter, request)
    if (identity === undefined) return
    const active = this.playSessions.get(sessionKey)
    if (active !== undefined) {
      active.selection = selection
      active.transcript.push(`Player: ${request.text.slice(0, 800)}\nCompanion: ${reply.slice(0, 800)}`)
      while (active.transcript.length > 12) active.transcript.shift()
    }
    this.learningQueue = this.learningQueue
      .then(async () => {
        const extraction = await this.extract(adapter, request, reply, selection)
        if (extraction.shared !== undefined) this.store.updateSharedProfile(extraction.shared)
        this.store.remember(identity, extraction.gameMemories, interactionId)
      })
      .catch(error => {
        this.ctx.logger.warn('xiaotangyuan-game: 后台记忆提取失败，本轮回复不受影响')
        this.ctx.logger.warn(error)
      })
  }

  endSession(sessionKey: string): void {
    const active = this.playSessions.get(sessionKey)
    if (active === undefined) return
    this.playSessions.delete(sessionKey)
    this.finishActiveSession(active, Date.now())
  }

  private finishActiveSession(active: ActivePlaySession, now: number): void {
    if (active.identity !== undefined) this.store.endPlaySession(active.storageId, active.identity, now)
    if (!this.config.autoLearn || active.identity === undefined || active.selection === undefined || active.transcript.length < 2) return
    const snapshot = { ...active, transcript: [...active.transcript] }
    this.learningQueue = this.learningQueue
      .then(async () => {
        const extraction = await this.extractSessionSummary(snapshot)
        this.store.remember(snapshot.identity!, extraction.gameMemories, `session:${snapshot.storageId}`)
      })
      .catch(error => {
        this.ctx.logger.warn('xiaotangyuan-game: 游玩阶段总结失败，已有记忆和统计不受影响')
        this.ctx.logger.warn(error)
      })
  }

  private async extract(
    adapter: AdapterHello,
    request: GameChatRequest,
    reply: string,
    selection: ModelSelection,
  ): Promise<MemoryExtraction> {
    return await this.extractWithPrompt(EXTRACTION_SYSTEM_PROMPT, extractionInput(adapter, request, reply), selection)
  }

  private async extractSessionSummary(active: ActivePlaySession): Promise<MemoryExtraction> {
    return await this.extractWithPrompt(
      SESSION_SUMMARY_SYSTEM_PROMPT,
      [`Game: ${active.adapter.gameId}`, `Completed session transcript:\n${active.transcript.join('\n\n')}`].join('\n'),
      active.selection!,
    )
  }

  private async extractWithPrompt(system: string, input: string, selection: ModelSelection): Promise<MemoryExtraction> {
    const assembler = new BlockAssembler()
    const signal = AbortSignal.timeout(45_000)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: 'user' },
    })]
    for await (const chunk of this.ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages,
      system,
      temperature: 0,
      maxTokens: 700,
      signal,
      purpose: 'compaction',
    })) assembler.push(chunk)
    const text = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return parseMemoryExtraction(text)
  }

  async close(): Promise<void> {
    this.closing = true
    for (const sessionKey of [...this.playSessions.keys()]) this.endSession(sessionKey)
    await this.learningQueue
    this.store.close()
  }

  async flush(): Promise<void> {
    await this.learningQueue
  }
}
