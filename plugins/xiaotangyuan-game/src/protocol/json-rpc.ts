export const JSON_RPC_VERSION = '2.0' as const

export type RpcId = string | number | null

export interface RpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION
  id?: RpcId
  method: string
  params?: unknown
}

export interface RpcSuccess {
  jsonrpc: typeof JSON_RPC_VERSION
  id: RpcId
  result: unknown
}

export interface RpcFailure {
  jsonrpc: typeof JSON_RPC_VERSION
  id: RpcId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export function parseRpcRequest(raw: string): RpcRequest {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('JSON-RPC payload must be an object')
  }

  const record = value as Record<string, unknown>
  if (record.jsonrpc !== JSON_RPC_VERSION) throw new Error('jsonrpc must be "2.0"')
  if (typeof record.method !== 'string' || record.method.trim() === '') {
    throw new Error('method must be a non-empty string')
  }
  if (record.id !== undefined && record.id !== null && typeof record.id !== 'string' && typeof record.id !== 'number') {
    throw new Error('id must be a string, number, or null')
  }

  return {
    jsonrpc: JSON_RPC_VERSION,
    ...(record.id === undefined ? {} : { id: record.id as RpcId }),
    method: record.method,
    ...(record.params === undefined ? {} : { params: record.params }),
  }
}

export function success(id: RpcId, result: unknown): RpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

export function failure(id: RpcId, code: number, message: string, data?: unknown): RpcFailure {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}
