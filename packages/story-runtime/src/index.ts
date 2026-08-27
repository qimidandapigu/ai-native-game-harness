import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GameObservation, JsonValue } from '@ai-native-game-harness/adapter-protocol'

export const STORY_BEAT_SCHEMA_VERSION = 1 as const
export const NARRATIVE_POLICY_SCHEMA_VERSION = 1 as const
const STORY_DOCUMENT_SCHEMA_VERSION = 1 as const
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const CONDITION_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const MAX_ACTIVE_HISTORY = 200
const MAX_ATTEMPTS = 100
const MAX_PLANNED_BEATS = 3

export type StoryConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'includes'
export type StoryStatus = 'needs-generation' | 'active' | 'awaiting-choice' | 'ended'
export type StoryOutcome = 'completed' | 'failed'

export interface StoryCondition {
  /** Dot path relative to GameObservation.state. */
  path: string
  operator: StoryConditionOperator
  value: JsonValue
}

export interface StoryChoice {
  id: string
  label: string
  direction: string
}

/** Model-generated, validated intermediate form. It is not authored plot content. */
export interface StoryBeatV1 {
  schemaVersion: typeof STORY_BEAT_SCHEMA_VERSION
  id: string
  title: string
  premise: string
  goal: string
  characterMotivation?: string
  completion: StoryCondition
  failure?: StoryCondition
  capabilityHints?: string[]
  nextDirections?: string[]
  choices?: StoryChoice[]
  ending?: boolean
}

export interface NarrativePolicyV1 {
  schemaVersion: typeof NARRATIVE_POLICY_SCHEMA_VERSION
  kind: 'dynamic-narrative-policy'
  world: string
  themes?: string[]
  allowedGoals?: string[]
  forbiddenClaims?: string[]
  pacing?: string
}

export interface StoryIdentity {
  gameId: string
  saveId: string
}

export interface StoryEvidence {
  observationRevision: number
  condition: StoryCondition
  actualValue: JsonValue | undefined
}

export interface StoryHistoryEntry {
  beat: StoryBeatV1
  outcome: StoryOutcome
  occurredAt: string
  evidence: StoryEvidence
  selectedChoice?: StoryChoice
}

export interface StoryState {
  schemaVersion: 1
  gameId: string
  saveId: string
  revision: number
  status: StoryStatus
  activeBeat?: StoryBeatV1
  queuedBeats: StoryBeatV1[]
  pendingChoices: StoryChoice[]
  openThreads: string[]
  history: StoryHistoryEntry[]
  updatedAt: string
}

export interface StoryGenerationAttempt {
  id: string
  gameId: string
  saveId: string
  proposedBeatIds: string[]
  accepted: boolean
  createdAt: string
  error?: string
}

export interface StoryProductSnapshot {
  schemaVersion: 1
  updatedAt: string
  activeGameId?: string
  states: StoryState[]
  generationAttempts: StoryGenerationAttempt[]
}

interface StoryDocument {
  schemaVersion: typeof STORY_DOCUMENT_SCHEMA_VERSION
  states: StoryState[]
  generationAttempts: StoryGenerationAttempt[]
}

export interface StoryProposalContext {
  identity: StoryIdentity
  observation: GameObservation
  actionCapabilities: ReadonlySet<string>
}

export interface StoryTransition {
  changed: boolean
  state: StoryState
  outcome?: StoryOutcome
  beatId?: string
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function now(): string {
  return new Date().toISOString()
}

function limitedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  const text = value.trim()
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`)
  return text
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} must be a lowercase safe id`)
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`))
    return
  }
  if (typeof value === 'object' && value !== null) {
    Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${label}.${key}`))
    return
  }
  throw new Error(`${label} must be JSON-compatible`)
}

function assertCondition(value: unknown, label: string): asserts value is StoryCondition {
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object`)
  const condition = value as Partial<StoryCondition>
  if (typeof condition.path !== 'string' || !CONDITION_PATH.test(condition.path)) {
    throw new Error(`${label}.path must be a safe dot path relative to observation.state`)
  }
  if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes'].includes(String(condition.operator))) {
    throw new Error(`${label}.operator is unsupported`)
  }
  assertJsonValue(condition.value, `${label}.value`)
}

function optionalStrings(value: unknown, label: string, maximumItems: number, maximumLength: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must contain at most ${maximumItems} items`)
  return value.map((item, index) => limitedText(item, `${label}[${index}]`, maximumLength))
}

export function assertStoryBeat(value: unknown): asserts value is StoryBeatV1 {
  if (typeof value !== 'object' || value === null) throw new Error('Story beat must be an object')
  const beat = value as Partial<StoryBeatV1>
  if (beat.schemaVersion !== STORY_BEAT_SCHEMA_VERSION) throw new Error('Unsupported StoryBeat schema version')
  assertSafeId(beat.id, 'StoryBeat.id')
  limitedText(beat.title, 'StoryBeat.title', 120)
  limitedText(beat.premise, 'StoryBeat.premise', 1_000)
  limitedText(beat.goal, 'StoryBeat.goal', 500)
  if (beat.characterMotivation !== undefined) limitedText(beat.characterMotivation, 'StoryBeat.characterMotivation', 500)
  assertCondition(beat.completion, 'StoryBeat.completion')
  if (beat.failure !== undefined) assertCondition(beat.failure, 'StoryBeat.failure')
  optionalStrings(beat.capabilityHints, 'StoryBeat.capabilityHints', 12, 120)
  optionalStrings(beat.nextDirections, 'StoryBeat.nextDirections', 6, 300)
  if (beat.choices !== undefined) {
    if (!Array.isArray(beat.choices) || beat.choices.length < 2 || beat.choices.length > 4) {
      throw new Error('StoryBeat.choices must contain 2 to 4 choices')
    }
    const ids = new Set<string>()
    for (const [index, choice] of beat.choices.entries()) {
      if (typeof choice !== 'object' || choice === null) throw new Error(`StoryBeat.choices[${index}] must be an object`)
      assertSafeId(choice.id, `StoryBeat.choices[${index}].id`)
      if (ids.has(choice.id)) throw new Error(`Duplicate story choice: ${choice.id}`)
      ids.add(choice.id)
      limitedText(choice.label, `StoryBeat.choices[${index}].label`, 160)
      limitedText(choice.direction, `StoryBeat.choices[${index}].direction`, 500)
    }
  }
  if (beat.ending !== undefined && typeof beat.ending !== 'boolean') throw new Error('StoryBeat.ending must be boolean')
}

export function parseNarrativePolicy(text: string): NarrativePolicyV1 {
  const value = JSON.parse(text) as Partial<NarrativePolicyV1>
  if (value.schemaVersion !== NARRATIVE_POLICY_SCHEMA_VERSION || value.kind !== 'dynamic-narrative-policy') {
    throw new Error('Unsupported dynamic narrative policy')
  }
  limitedText(value.world, 'NarrativePolicy.world', 4_000)
  optionalStrings(value.themes, 'NarrativePolicy.themes', 20, 200)
  optionalStrings(value.allowedGoals, 'NarrativePolicy.allowedGoals', 30, 300)
  optionalStrings(value.forbiddenClaims, 'NarrativePolicy.forbiddenClaims', 30, 300)
  if (value.pacing !== undefined) limitedText(value.pacing, 'NarrativePolicy.pacing', 500)
  return clone(value as NarrativePolicyV1)
}

export function observationValue(observation: GameObservation, path: string): JsonValue | undefined {
  if (!CONDITION_PATH.test(path)) return undefined
  let current: JsonValue = observation.state
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(segment in current)) return undefined
    current = current[segment] as JsonValue
  }
  return current
}

export function evaluateStoryCondition(observation: GameObservation, condition: StoryCondition): boolean {
  const actual = observationValue(observation, condition.path)
  const expected = condition.value
  if (condition.operator === 'eq') return JSON.stringify(actual) === JSON.stringify(expected)
  if (condition.operator === 'neq') return JSON.stringify(actual) !== JSON.stringify(expected)
  if (condition.operator === 'includes') {
    if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
    if (Array.isArray(actual)) return actual.some(item => JSON.stringify(item) === JSON.stringify(expected))
    return false
  }
  if (typeof actual !== 'number' || typeof expected !== 'number') return false
  if (condition.operator === 'gt') return actual > expected
  if (condition.operator === 'gte') return actual >= expected
  if (condition.operator === 'lt') return actual < expected
  return actual <= expected
}

function emptyState(identity: StoryIdentity): StoryState {
  return {
    schemaVersion: 1,
    gameId: identity.gameId,
    saveId: identity.saveId,
    revision: 0,
    status: 'needs-generation',
    queuedBeats: [],
    pendingChoices: [],
    openThreads: [],
    history: [],
    updatedAt: now(),
  }
}

function documentDefault(): StoryDocument {
  return { schemaVersion: STORY_DOCUMENT_SCHEMA_VERSION, states: [], generationAttempts: [] }
}

function identityKey(identity: StoryIdentity): string {
  return `${identity.gameId}\u0000${identity.saveId}`
}

export class StoryStore {
  readonly directory: string
  readonly file: string
  #document?: StoryDocument
  #operations: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.directory = resolve(directory)
    this.file = join(this.directory, 'story-state-v1.json')
  }

  async state(identity: StoryIdentity): Promise<StoryState> {
    return await this.#exclusive(async document => {
      const found = document.states.find(item => identityKey(item) === identityKey(identity))
      if (found !== undefined) return clone(found)
      const created = emptyState(identity)
      document.states.push(clone(created))
      await this.#write(document)
      return clone(created)
    })
  }

  async states(gameId?: string): Promise<StoryState[]> {
    return await this.#exclusive(async document => document.states
      .filter(state => gameId === undefined || state.gameId === gameId)
      .map(clone))
  }

  async attempts(gameId?: string): Promise<StoryGenerationAttempt[]> {
    return await this.#exclusive(async document => document.generationAttempts
      .filter(attempt => gameId === undefined || attempt.gameId === gameId)
      .map(clone))
  }

  async update(identity: StoryIdentity, change: (state: StoryState) => StoryState): Promise<StoryState> {
    return await this.#exclusive(async document => {
      const index = document.states.findIndex(item => identityKey(item) === identityKey(identity))
      const current = clone(index < 0 ? emptyState(identity) : document.states[index]!)
      const next = change(current)
      next.updatedAt = now()
      if (index < 0) document.states.push(clone(next)); else document.states[index] = clone(next)
      await this.#write(document)
      return clone(next)
    })
  }

  async recordAttempt(attempt: StoryGenerationAttempt): Promise<void> {
    await this.#exclusive(async document => {
      document.generationAttempts.push(clone(attempt))
      document.generationAttempts = document.generationAttempts.slice(-MAX_ATTEMPTS)
      await this.#write(document)
    })
  }

  async #load(): Promise<StoryDocument> {
    if (this.#document !== undefined) return this.#document
    await mkdir(this.directory, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as StoryDocument
      this.#document = parsed.schemaVersion === STORY_DOCUMENT_SCHEMA_VERSION
        && Array.isArray(parsed.states) && Array.isArray(parsed.generationAttempts)
        ? parsed
        : documentDefault()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#document = documentDefault()
    }
    return this.#document
  }

  async #write(document: StoryDocument): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const staging = `${this.file}.${randomUUID()}.tmp`
    await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(staging, this.file)
  }

  async #exclusive<T>(operation: (document: StoryDocument) => Promise<T>): Promise<T> {
    const result = this.#operations.then(async () => operation(await this.#load()))
    this.#operations = result.then(() => undefined, () => undefined)
    return await result
  }
}

export class StoryRuntime {
  constructor(readonly store: StoryStore) {}

  async state(identity: StoryIdentity): Promise<StoryState> {
    return await this.store.state(identity)
  }

  async propose(beats: StoryBeatV1[], context: StoryProposalContext): Promise<StoryState> {
    const attempt: StoryGenerationAttempt = {
      id: randomUUID(),
      gameId: context.identity.gameId,
      saveId: context.identity.saveId,
      proposedBeatIds: beats.map(beat => typeof beat?.id === 'string' ? beat.id.slice(0, 100) : 'invalid'),
      accepted: false,
      createdAt: now(),
    }
    try {
      this.#validatePlan(beats, context)
      const state = await this.store.update(context.identity, current => {
        if (current.status === 'awaiting-choice' || current.status === 'ended') {
          throw new Error(`Cannot add generated beats while story is ${current.status}`)
        }
        const existingIds = new Set([
          ...current.history.map(item => item.beat.id),
          ...(current.activeBeat === undefined ? [] : [current.activeBeat.id]),
          ...current.queuedBeats.map(item => item.id),
        ])
        for (const beat of beats) {
          if (existingIds.has(beat.id)) throw new Error(`Story beat id already exists in this save: ${beat.id}`)
          existingIds.add(beat.id)
        }
        const capacity = MAX_PLANNED_BEATS - (current.activeBeat === undefined ? 0 : 1) - current.queuedBeats.length
        if (beats.length > capacity) throw new Error(`Rolling story plan exceeds ${MAX_PLANNED_BEATS} active and queued beats`)
        const queue = beats.map(clone)
        if (current.activeBeat === undefined) {
          current.activeBeat = queue.shift()
          current.status = current.activeBeat === undefined ? 'needs-generation' : 'active'
        }
        current.queuedBeats.push(...queue)
        current.revision += 1
        return current
      })
      attempt.accepted = true
      await this.store.recordAttempt(attempt)
      return state
    } catch (error) {
      attempt.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      await this.store.recordAttempt(attempt)
      throw error
    }
  }

  async observe(identity: StoryIdentity, observation: GameObservation): Promise<StoryTransition> {
    const current = await this.store.state(identity)
    const beat = current.activeBeat
    if (beat === undefined || current.status !== 'active') return { changed: false, state: current }
    const failed = beat.failure !== undefined && evaluateStoryCondition(observation, beat.failure)
    const completed = evaluateStoryCondition(observation, beat.completion)
    if (!failed && !completed) return { changed: false, state: current }
    const outcome: StoryOutcome = failed ? 'failed' : 'completed'
    const condition = failed ? beat.failure! : beat.completion
    const state = await this.store.update(identity, draft => {
      if (draft.activeBeat?.id !== beat.id || draft.status !== 'active') return draft
      draft.history.push({
        beat: clone(beat),
        outcome,
        occurredAt: now(),
        evidence: {
          observationRevision: observation.revision,
          condition: clone(condition),
          actualValue: clone(observationValue(observation, condition.path)),
        },
      })
      draft.history = draft.history.slice(-MAX_ACTIVE_HISTORY)
      draft.activeBeat = undefined
      if (outcome === 'failed') {
        draft.queuedBeats = []
        draft.pendingChoices = []
        draft.status = 'needs-generation'
      } else if (beat.choices?.length) {
        draft.queuedBeats = []
        draft.pendingChoices = beat.choices.map(clone)
        draft.status = 'awaiting-choice'
      } else if (beat.ending) {
        draft.queuedBeats = []
        draft.pendingChoices = []
        draft.status = 'ended'
      } else {
        draft.activeBeat = draft.queuedBeats.shift()
        draft.status = draft.activeBeat === undefined ? 'needs-generation' : 'active'
      }
      draft.revision += 1
      return draft
    })
    return { changed: true, state, outcome, beatId: beat.id }
  }

  async choose(identity: StoryIdentity, choiceId: string): Promise<StoryState> {
    return await this.store.update(identity, state => {
      if (state.status !== 'awaiting-choice') throw new Error('Story is not waiting for a player choice')
      const choice = state.pendingChoices.find(item => item.id === choiceId)
      if (choice === undefined) throw new Error(`Unknown story choice: ${choiceId}`)
      const latest = state.history.at(-1)
      if (latest !== undefined) latest.selectedChoice = clone(choice)
      state.openThreads.push(choice.direction)
      state.openThreads = state.openThreads.slice(-20)
      state.pendingChoices = []
      state.status = 'needs-generation'
      state.revision += 1
      return state
    })
  }

  async snapshot(activeGameId?: string): Promise<StoryProductSnapshot> {
    return {
      schemaVersion: 1,
      updatedAt: now(),
      ...(activeGameId === undefined ? {} : { activeGameId }),
      states: await this.store.states(activeGameId),
      generationAttempts: await this.store.attempts(activeGameId),
    }
  }

  #validatePlan(beats: StoryBeatV1[], context: StoryProposalContext): void {
    if (!Array.isArray(beats) || beats.length < 1 || beats.length > MAX_PLANNED_BEATS) {
      throw new Error(`Generated story plan must contain 1 to ${MAX_PLANNED_BEATS} beats`)
    }
    const ids = new Set<string>()
    for (const [index, beat] of beats.entries()) {
      assertStoryBeat(beat)
      if (ids.has(beat.id)) throw new Error(`Duplicate generated StoryBeat id: ${beat.id}`)
      ids.add(beat.id)
      if (observationValue(context.observation, beat.completion.path) === undefined) {
        throw new Error(`StoryBeat ${beat.id} completion path is not present in the authoritative observation: ${beat.completion.path}`)
      }
      if (evaluateStoryCondition(context.observation, beat.completion)) {
        throw new Error(`StoryBeat ${beat.id} completion condition is already true`)
      }
      if (beat.failure !== undefined && observationValue(context.observation, beat.failure.path) === undefined) {
        throw new Error(`StoryBeat ${beat.id} failure path is not present in the authoritative observation: ${beat.failure.path}`)
      }
      for (const capability of beat.capabilityHints ?? []) {
        if (!context.actionCapabilities.has(capability)) {
          throw new Error(`StoryBeat ${beat.id} references unavailable Adapter action: ${capability}`)
        }
      }
      if (beat.choices?.length && index !== beats.length - 1) {
        throw new Error(`StoryBeat ${beat.id} has choices and must be the final rolling-plan beat`)
      }
      if (beat.ending && index !== beats.length - 1) {
        throw new Error(`Ending StoryBeat ${beat.id} must be the final rolling-plan beat`)
      }
    }
  }
}
