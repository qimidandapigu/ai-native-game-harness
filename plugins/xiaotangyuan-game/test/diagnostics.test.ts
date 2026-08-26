import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_DIAGNOSTIC_PREFIX, publishProductDiagnostic } from '../src/runtime/diagnostics.js'

describe('product diagnostics', () => {
  afterEach(() => vi.restoreAllMocks())

  it('publishes one machine-readable measurement record without conversation content', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const record = publishProductDiagnostic({
      kind: 'game-agent.latency',
      sessionId: 'session-1',
      gameId: 'oni',
      interactionId: 'interaction-1',
      detail: { source: 'voice', firstTextMs: 120, totalMs: 640 },
    })
    expect(record).toMatchObject({
      schemaVersion: 1,
      kind: 'game-agent.latency',
      sessionId: 'session-1',
      detail: { firstTextMs: 120, totalMs: 640 },
    })
    const output = String(write.mock.calls[0]?.[0])
    expect(output.startsWith(PRODUCT_DIAGNOSTIC_PREFIX)).toBe(true)
    expect(JSON.parse(output.slice(PRODUCT_DIAGNOSTIC_PREFIX.length))).toEqual(record)
    expect(output).not.toContain('transcript')
    expect(output).not.toContain('reasoning')
  })
})
