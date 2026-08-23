import { describe, expect, it } from 'vitest'
import { readAdapterHello, readGameRetry } from '../src/protocol/game.js'
import { failure, parseRpcRequest, success } from '../src/protocol/json-rpc.js'

describe('JSON-RPC protocol', () => {
  it('parses a valid request', () => {
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"gateway.ping"}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'gateway.ping',
    })
  })

  it('rejects an invalid version', () => {
    expect(() => parseRpcRequest('{"jsonrpc":"1.0","method":"gateway.ping"}')).toThrow('jsonrpc')
  })

  it('builds success and failure responses', () => {
    expect(success('a', { ok: true })).toEqual({ jsonrpc: '2.0', id: 'a', result: { ok: true } })
    expect(failure('a', -1, 'nope')).toEqual({
      jsonrpc: '2.0',
      id: 'a',
      error: { code: -1, message: 'nope' },
    })
  })

  it('parses retry context without requiring duplicate player text', () => {
    expect(readGameRetry({ context: { playerName: 'Wilson', observation: { day: 3 } } })).toMatchObject({
      context: { playerName: 'Wilson', observation: { day: 3 } },
    })
  })

  it('accepts opaque save identities and rejects local paths', () => {
    expect(readAdapterHello({
      adapterId: 'test', gameId: 'test-game', version: '1', protocolVersion: '1.1', saveId: 'save_01-ab',
    }).saveId).toBe('save_01-ab')
    expect(() => readAdapterHello({
      adapterId: 'test', gameId: 'test-game', version: '1', protocolVersion: '1.1', saveId: 'C:\\Users\\player\\save',
    })).toThrow('saveId')
  })
})
