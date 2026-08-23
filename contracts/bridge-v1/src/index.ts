export const BRIDGE_PROTOCOL_VERSION = '1.0' as const

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export interface JsonObject { [key: string]: JsonValue }

export interface BridgeHello {
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION
  bridgeId: string
  bridgeVersion: string
  gameId: string
  gameVersion?: string
  capabilities: string[]
}

export interface GameObservation<TState extends JsonObject = JsonObject> extends JsonObject {
  gameId: string
  saveId: string
  revision: number
  observedAt: string
  state: TState
}

export interface BridgeEvent {
  method: string
  params: JsonObject
}

export type RpcId = string

export interface BridgeRequest extends JsonObject {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params: JsonObject
}

export interface BridgeSuccess extends JsonObject {
  jsonrpc: '2.0'
  id: RpcId
  result: JsonValue
}

export interface BridgeFailure extends JsonObject {
  jsonrpc: '2.0'
  id: RpcId
  error: {
    code: number
    message: string
    data?: JsonValue
  }
}

export type BridgeResponse = BridgeSuccess | BridgeFailure

export type BridgeEventListener = (event: BridgeEvent) => void

export interface NativeBridge {
  hello(): BridgeHello
  request(method: string, params: JsonObject, signal: AbortSignal): Promise<JsonValue>
  subscribe(listener: BridgeEventListener): () => void
  close(): void | Promise<void>
}

export function assertBridgeHello(value: BridgeHello): void {
  if (value.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error(`unsupported bridge protocol: ${value.protocolVersion}`)
  }
  if (!value.bridgeId || !value.bridgeVersion || !value.gameId) {
    throw new Error('bridge hello must include bridgeId, bridgeVersion, and gameId')
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item !== 'string')) {
    throw new Error('bridge capabilities must be strings')
  }
}

export function assertObservation(value: JsonValue): asserts value is GameObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('game observation must be an object')
  }
  if (typeof value.gameId !== 'string' || typeof value.saveId !== 'string') {
    throw new Error('game observation must identify gameId and saveId')
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error('game observation revision must be a non-negative integer')
  }
  if (typeof value.observedAt !== 'string' || typeof value.state !== 'object' || value.state === null || Array.isArray(value.state)) {
    throw new Error('game observation must include observedAt and object state')
  }
}
