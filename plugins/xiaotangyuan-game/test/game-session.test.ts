import { describe, expect, it } from 'vitest'
import { persistentGameSessionId } from '../src/runtime/agent/game-agent-session.js'

describe('persistent game sessions', () => {
  it('reuses one session for the same game save across Adapter reconnects', () => {
    const adapter = {
      adapterId: 'test.oni', gameId: 'oxygen-not-included', version: '1.0.0', protocolVersion: '1.1', saveId: 'colony-a',
    }
    expect(persistentGameSessionId(adapter)).toBe(persistentGameSessionId({ ...adapter, processId: 999 }))
  })

  it('isolates different saves and does not expose the raw save id', () => {
    const adapter = { adapterId: 'test.dst', gameId: 'dont-starve-together', version: '1.0.0', protocolVersion: '1.1' }
    const first = persistentGameSessionId(adapter, 'secret-save-a')
    const second = persistentGameSessionId(adapter, 'secret-save-b')
    expect(first).not.toBe(second)
    expect(first).not.toContain('secret-save-a')
  })
})
