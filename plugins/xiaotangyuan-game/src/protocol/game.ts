export interface AdapterHello {
  adapterId: string
  gameId: string
  version: string
  protocolVersion: string
  processId?: number
  saveId?: string
  capabilities?: string[]
  atoms?: GameAtomDefinition[]
}

export interface GameAtomDefinition {
  name: string
  description: string
  parameters: string
  returns: string
}

export interface GameChatContext {
  roleInstructions?: string
  playerName?: string
  location?: string
  date?: string
  time?: string
  nearbyNpc?: string
  saveId?: string
  observation?: Record<string, unknown>
}

export interface GameChatRequest {
  text: string
  context?: GameChatContext
}

export interface GameRetryRequest {
  context?: GameChatContext
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('params must be an object')
  }
  return value as Record<string, unknown>
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function readAdapterHello(value: unknown): AdapterHello {
  const params = asRecord(value)
  const required = ['adapterId', 'gameId', 'version', 'protocolVersion'] as const
  for (const key of required) {
    if (typeof params[key] !== 'string' || params[key].trim() === '') {
      throw new Error(`${key} must be a non-empty string`)
    }
  }
  const processId = params.processId
  if (processId !== undefined && (!Number.isSafeInteger(processId) || (processId as number) <= 0)) {
    throw new Error('processId must be a positive integer when provided')
  }
  const capabilities = params.capabilities
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== 'string'))) {
    throw new Error('capabilities must be an array of strings when provided')
  }
  const atoms = params.atoms
  if (atoms !== undefined) {
    if (!Array.isArray(atoms) || atoms.length > 50) throw new Error('atoms must be an array with at most 50 entries')
    for (const atom of atoms) {
      const definition = asRecord(atom)
      for (const key of ['name', 'description', 'parameters', 'returns'] as const) {
        if (typeof definition[key] !== 'string' || definition[key].trim() === '' || definition[key].length > 500) {
          throw new Error(`atom ${key} must be a non-empty string with at most 500 characters`)
        }
      }
      if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(definition.name as string)) throw new Error('atom name is invalid')
    }
  }
  const saveId = optionalString(params, 'saveId')
  if (saveId !== undefined && (!/^[a-zA-Z0-9._:-]{1,128}$/.test(saveId))) {
    throw new Error('saveId must contain 1-128 safe opaque identifier characters')
  }
  return params as unknown as AdapterHello
}

export function readGameChat(value: unknown): GameChatRequest {
  const params = asRecord(value)
  if (typeof params.text !== 'string' || params.text.trim() === '') {
    throw new Error('text must be a non-empty string')
  }

  const context = readContext(params.context)

  return { text: params.text.trim(), ...(context === undefined ? {} : { context }) }
}

function limitedOptionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = optionalString(record, key)
  if (value !== undefined && value.length > maxLength) throw new Error(`${key} must be at most ${maxLength} characters`)
  return value
}

function optionalOpaqueId(record: Record<string, unknown>, key: string): string | undefined {
  const value = limitedOptionalString(record, key, 128)
  if (value !== undefined && !/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new Error(`${key} must contain only safe opaque identifier characters`)
  }
  return value
}

export function readGameRetry(value: unknown): GameRetryRequest {
  const params = asRecord(value)
  const context = readContext(params.context)
  return context === undefined ? {} : { context }
}

function readContext(value: unknown): GameChatContext | undefined {
  if (value === undefined) return undefined
  const source = asRecord(value)
  return {
    roleInstructions: limitedOptionalString(source, 'roleInstructions', 2_000),
    playerName: optionalString(source, 'playerName'),
    location: optionalString(source, 'location'),
    date: optionalString(source, 'date'),
    time: optionalString(source, 'time'),
    nearbyNpc: optionalString(source, 'nearbyNpc'),
    saveId: optionalOpaqueId(source, 'saveId'),
    ...(source.observation === undefined ? {} : { observation: asRecord(source.observation) }),
  }
}

export function readStateUpdate(value: unknown): Record<string, unknown> {
  const params = asRecord(value)
  return asRecord(params.observation)
}

export function readStateUpdateSaveId(value: unknown): string | undefined {
  return optionalOpaqueId(asRecord(value), 'saveId')
}
