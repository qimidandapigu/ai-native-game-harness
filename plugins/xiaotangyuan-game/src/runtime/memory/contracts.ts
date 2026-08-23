import type { AdapterHello, GameChatRequest } from '../../protocol/game.js'

export const GAME_MEMORY_KINDS = ['goal', 'preference', 'relationship', 'decision', 'milestone', 'promise'] as const
export type GameMemoryKind = typeof GAME_MEMORY_KINDS[number]

export interface SharedProfile {
  preferredName?: string
  language?: string
  responseStyle?: string
  interests: string[]
  playStyles: string[]
  playedGames: string[]
  companionName?: string
  companionTraits: string[]
}

export interface SharedProfilePatch {
  preferredName?: string
  language?: string
  responseStyle?: string
  interests?: string[]
  playStyles?: string[]
  companionName?: string
  companionTraits?: string[]
}

export interface GameMemoryCandidate {
  kind: GameMemoryKind
  subject: string
  summary: string
  importance: number
}

export interface MemoryExtraction {
  shared?: SharedProfilePatch
  gameMemories: GameMemoryCandidate[]
}

export interface MemoryIdentity {
  gameId: string
  saveId: string
}

export interface RememberedGameEvent extends GameMemoryCandidate {
  id: string
  gameId: string
  saveId: string
  status: 'active' | 'superseded'
  createdAt: number
  updatedAt: number
}

export interface PlayStatistics {
  gameId: string
  saveId: string
  sessionCount: number
  playDays: number
  activeMs: number
  lastPlayedAt: number
  memoryCount: number
}

export interface GamePlayStatistics {
  gameId: string
  saveCount: number
  sessionCount: number
  playDays: number
  activeMs: number
  lastPlayedAt: number
}

export type EditableSharedField = Exclude<keyof SharedProfile, 'playedGames'>

function opaqueSaveId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : undefined
}

export function resolveExplicitMemoryIdentity(adapter: AdapterHello | undefined, request?: GameChatRequest): MemoryIdentity | undefined {
  if (adapter === undefined) return undefined
  const observation = request?.context?.observation
  const saveId = opaqueSaveId(request?.context?.saveId)
    ?? opaqueSaveId(adapter.saveId)
    ?? opaqueSaveId(observation?.saveId)
    ?? opaqueSaveId(observation?.save_id)
  return saveId === undefined ? undefined : { gameId: adapter.gameId, saveId }
}

export function resolveMemoryIdentity(adapter: AdapterHello | undefined, request?: GameChatRequest): MemoryIdentity | undefined {
  if (adapter === undefined) return undefined
  return resolveExplicitMemoryIdentity(adapter, request) ?? { gameId: adapter.gameId, saveId: 'default' }
}
