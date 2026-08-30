import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { WorkExecutorKind } from './config.js'

const SCHEMA_VERSION = 1
const FILE_NAME = 'work-session-links-v1.json'
const WORKER_PREFIXES = ['dsh-work-', 'xiaotangyuan-work-']

export type WorkSessionLinkStatus = 'active' | 'waiting' | 'unavailable'

export interface WorkSessionLink {
  companionSessionId: string
  workerSessionId: string
  title: string
  selection: ModelSelection
  status: WorkSessionLinkStatus
  executor: WorkExecutorKind
  codexThreadId?: string
  codexDelegated?: true
  updatedAt: number
}

interface WorkSessionLinkFile {
  schemaVersion: typeof SCHEMA_VERSION
  links: Record<string, WorkSessionLink>
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned === '' ? undefined : cleaned.slice(0, maximum)
}

function readSelection(value: unknown): ModelSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const provider = boundedString(raw.provider, 120)
  const model = boundedString(raw.model, 200)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = boundedString(raw.reasoningEffort, 80)
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as ModelSelection['reasoningEffort'] }),
  }
}

function readLink(value: unknown, key: string): WorkSessionLink | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const companionSessionId = boundedString(raw.companionSessionId, 240)
  const workerSessionId = boundedString(raw.workerSessionId, 240)
  const title = boundedString(raw.title, 80)
  const selection = readSelection(raw.selection)
  const status = raw.status === 'active' || raw.status === 'waiting' || raw.status === 'unavailable'
    ? raw.status
    : undefined
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined
  const codexThreadId = boundedString(raw.codexThreadId, 240)
  // Builds before 0.1.2 assigned every task to Codex from configuration. Only
  // links carrying this explicit marker may resume Codex after the migration.
  const codexDelegated = raw.codexDelegated === true && codexThreadId !== undefined
  const executor: WorkExecutorKind = raw.executor === 'codex-app-server' && codexDelegated ? 'codex-app-server' : 'dsh'
  if (companionSessionId !== key
    || workerSessionId === undefined
    || !WORKER_PREFIXES.some(prefix => workerSessionId.startsWith(prefix))
    || title === undefined
    || selection === undefined
    || status === undefined
    || updatedAt === undefined) return undefined
  return {
    companionSessionId,
    workerSessionId,
    title,
    selection,
    status,
    executor,
    ...(codexDelegated ? { codexThreadId, codexDelegated: true as const } : {}),
    updatedAt,
  }
}

function emptyFile(): WorkSessionLinkFile {
  return { schemaVersion: SCHEMA_VERSION, links: {} }
}

/** Stores only stable source-to-Worker links; DSH persists the conversations. */
export class WorkSessionLinkStore {
  readonly filePath: string
  private readonly links = new Map<string, WorkSessionLink>()

  constructor(directory: string, legacyDirectories: readonly string[] = []) {
    mkdirSync(directory, { recursive: true })
    this.filePath = join(directory, FILE_NAME)
    const primaryExists = existsSync(this.filePath)
    this.loadFile(this.filePath)
    if (!primaryExists && this.links.size === 0) {
      for (const legacyDirectory of legacyDirectories) {
        this.loadFile(join(legacyDirectory, FILE_NAME))
        if (this.links.size > 0) {
          this.persist()
          break
        }
      }
    }
  }

  get(companionSessionId: string): WorkSessionLink | undefined {
    const link = this.links.get(companionSessionId)
    return link === undefined ? undefined : structuredClone(link)
  }

  set(link: WorkSessionLink): void {
    this.links.set(link.companionSessionId, structuredClone(link))
    this.persist()
  }

  private loadFile(filePath: string): void {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const value = JSON.parse(raw) as Partial<WorkSessionLinkFile>
      if (value.schemaVersion !== SCHEMA_VERSION || typeof value.links !== 'object' || value.links === null) return
      for (const [key, candidate] of Object.entries(value.links)) {
        const link = readLink(candidate, key)
        if (link !== undefined) this.links.set(key, link)
      }
    } catch {
      // A malformed index must not prevent the DSH plugin from starting.
    }
  }

  private persist(): void {
    const value: WorkSessionLinkFile = {
      ...emptyFile(),
      links: Object.fromEntries([...this.links.entries()].sort(([left], [right]) => left.localeCompare(right))),
    }
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, this.filePath)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }
}
