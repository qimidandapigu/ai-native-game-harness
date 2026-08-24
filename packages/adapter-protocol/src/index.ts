export const ADAPTER_PROTOCOL_VERSION = '1.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export const ADAPTER_RPC_METHOD = {
  hello: 'adapter.hello',
  observe: 'game.observe',
  execute: 'game.execute',
  event: 'game.event',
  ping: 'system.ping',
} as const

export const ADAPTER_RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  protocolVersionUnsupported: -32001,
  handshakeRequired: -32002,
  duplicateGame: -32003,
  adapterDisconnected: -32004,
  capabilityUnavailable: -32005,
  revisionConflict: -32006,
  actionRejected: -32007,
  requestTimeout: -32008,
} as const

export type AdapterConnectionState = 'connected' | 'disconnected'

export interface AdapterRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: JsonObject
}

export interface AdapterRpcNotification {
  jsonrpc: '2.0'
  method: string
  params: JsonObject
}

export interface AdapterRpcSuccess {
  jsonrpc: '2.0'
  id: string
  result: JsonValue
}

export interface AdapterRpcFailure {
  jsonrpc: '2.0'
  id: string | null
  error: {
    code: number
    message: string
    data?: JsonValue
  }
}

export type AdapterRpcMessage = AdapterRpcRequest | AdapterRpcNotification | AdapterRpcSuccess | AdapterRpcFailure

export interface AdapterHandshakeAck extends JsonObject {
  accepted: true
  protocolVersion: typeof ADAPTER_PROTOCOL_VERSION
  connectionId: string
}

export type CapabilityKind = 'observation' | 'action' | 'presentation'

export interface AdapterCapability {
  name: string
  kind: CapabilityKind
  description: string
  requiresApproval?: boolean
}

export interface AdapterHello {
  protocolVersion: typeof ADAPTER_PROTOCOL_VERSION
  adapterId: string
  gameId: string
  displayName: string
  adapterVersion: string
  capabilities: AdapterCapability[]
}

export interface GameObservation {
  gameId: string
  saveId: string
  revision: number
  observedAt: string
  state: Record<string, JsonValue>
}

export interface GameEvent {
  eventId: string
  gameId: string
  revision: number
  occurredAt: string
  type: string
  payload: Record<string, JsonValue>
}

export interface ActionRequest {
  requestId: string
  gameId: string
  capability: string
  arguments: Record<string, JsonValue>
  expectedRevision?: number
}

export interface ActionResult {
  requestId: string
  ok: boolean
  revision: number
  result?: Record<string, JsonValue>
  error?: {
    code: string
    message: string
  }
}

export interface GameAdapter {
  hello(): Promise<AdapterHello>
  observe(): Promise<GameObservation>
  execute(request: ActionRequest): Promise<ActionResult>
  subscribe?(listener: (event: GameEvent) => void): () => void
  connectionState?(): AdapterConnectionState
  subscribeConnection?(listener: (state: AdapterConnectionState) => void): () => void
  close?(): Promise<void>
}

export class AdapterRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message)
    this.name = 'AdapterRpcError'
  }
}

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a lowercase safe id`)
}

export function assertAdapterHello(value: AdapterHello): void {
  if (value.protocolVersion !== ADAPTER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported adapter protocol: ${value.protocolVersion}`)
  }
  assertSafeId(value.adapterId, 'adapterId')
  assertSafeId(value.gameId, 'gameId')
  if (!value.displayName.trim()) throw new Error('displayName is required')
  if (!value.adapterVersion.trim()) throw new Error('adapterVersion is required')
  const names = new Set<string>()
  for (const capability of value.capabilities) {
    if (!capability.name.trim()) throw new Error('Capability name is required')
    if (names.has(capability.name)) throw new Error(`Duplicate capability: ${capability.name}`)
    names.add(capability.name)
  }
}

export function assertObservation(value: GameObservation, expectedGameId?: string): void {
  assertSafeId(value.gameId, 'gameId')
  if (expectedGameId && value.gameId !== expectedGameId) throw new Error('Observation gameId mismatch')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('revision must be a non-negative integer')
  if (Number.isNaN(Date.parse(value.observedAt))) throw new Error('observedAt must be an ISO date')
}

export function assertActionResult(request: ActionRequest, result: ActionResult): void {
  if (request.requestId !== result.requestId) throw new Error('Action result requestId mismatch')
  if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('Action result revision is invalid')
  if (!result.ok && !result.error) throw new Error('Failed action result must include an error')
}

export function assertActionRequest(value: ActionRequest, expectedGameId?: string): void {
  if (!value.requestId.trim()) throw new Error('Action requestId is required')
  assertSafeId(value.gameId, 'gameId')
  if (expectedGameId && value.gameId !== expectedGameId) throw new Error('Action request gameId mismatch')
  if (!value.capability.trim()) throw new Error('Action capability is required')
  if (!isJsonObject(value.arguments)) throw new Error('Action arguments must be an object')
  if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) {
    throw new Error('expectedRevision must be a non-negative integer')
  }
}

export function assertGameEvent(value: GameEvent, expectedGameId?: string): void {
  if (!value.eventId.trim()) throw new Error('eventId is required')
  assertSafeId(value.gameId, 'gameId')
  if (expectedGameId && value.gameId !== expectedGameId) throw new Error('Game event gameId mismatch')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Game event revision is invalid')
  if (Number.isNaN(Date.parse(value.occurredAt))) throw new Error('occurredAt must be an ISO date')
  if (!value.type.trim()) throw new Error('Game event type is required')
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAdapterRpcMessage(raw: string): AdapterRpcMessage {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AdapterRpcError(ADAPTER_RPC_ERROR.parseError, 'Invalid JSON')
  }
  if (!isJsonObject(value) || value.jsonrpc !== '2.0') {
    throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'Invalid JSON-RPC message')
  }
  if (typeof value.method === 'string') {
    if (!isJsonObject(value.params)) throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidParams, 'params must be an object')
    if (value.id === undefined) return value as unknown as AdapterRpcNotification
    if (typeof value.id !== 'string') throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'request id must be a string')
    return value as unknown as AdapterRpcRequest
  }
  if (typeof value.id !== 'string' && value.id !== null) {
    throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'response id must be a string or null')
  }
  if ('error' in value) {
    if (!isJsonObject(value.error) || typeof value.error.code !== 'number' || typeof value.error.message !== 'string') {
      throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'Invalid JSON-RPC error')
    }
    return value as unknown as AdapterRpcFailure
  }
  if (!('result' in value)) throw new AdapterRpcError(ADAPTER_RPC_ERROR.invalidRequest, 'Response must include result or error')
  return value as unknown as AdapterRpcSuccess
}
