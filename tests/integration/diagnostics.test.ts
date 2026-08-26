import { describe, expect, it } from 'vitest'
// Desktop helpers are plain ESM so Electron and the browser can share them.
// @ts-expect-error JavaScript entry points do not publish declarations.
import { buildDiagnosticBundle, diagnosticFilename, sanitizeDiagnosticValue, traceMatchesFilter } from '../../apps/desktop/src/diagnostics.mjs'

describe('desktop diagnostics', () => {
  it('redacts credentials, omits private reasoning, truncates large values, and keeps audit ids', () => {
    const sanitized = sanitizeDiagnosticValue({
      sessionId: 'session-1',
      callId: 'call-1',
      apiKey: 'secret-value',
      transcript: 'private speech',
      nested: { authorization: 'Bearer private', chain_of_thought: 'private chain', result: 'x'.repeat(2_100) },
    })
    expect(sanitized).toMatchObject({
      sessionId: 'session-1',
      callId: 'call-1',
      apiKey: '[REDACTED]',
      transcript: '[OMITTED]',
      nested: { authorization: '[REDACTED]', chain_of_thought: '[OMITTED]' },
    })
    expect(sanitized.nested.result).toContain('[truncated 100 chars]')
  })

  it('builds a bounded product bundle without chat messages', () => {
    const bundle = buildDiagnosticBundle({
      runtime: { kind: 'dsh', sessionId: 'session-1', token: 'private' },
      adapters: [{ gameId: 'mock-game' }],
      observations: [{ gameId: 'mock-game', state: { player: { x: 2 } } }],
      traces: Array.from({ length: 510 }, (_, index) => ({ traceId: `trace-${index}`, kind: 'agent.event', detail: {} })),
    }, { appVersion: '0.1.0', gamePacks: [{ id: 'mock-pack' }] })
    expect(bundle.runtime).toMatchObject({ kind: 'dsh', sessionId: 'session-1', token: '[REDACTED]' })
    expect(bundle.traces).toHaveLength(500)
    expect(bundle.traces[0].traceId).toBe('trace-10')
    expect(bundle.gamePacks).toEqual([{ id: 'mock-pack' }])
    expect(bundle).not.toHaveProperty('messages')
  })

  it('filters failures, timeouts, reconnects, voice and correlated actions', () => {
    const traces = [
      { kind: 'action.executed', gameId: 'oni', detail: { ok: false, errorCode: 'BRIDGE_TIMEOUT', callId: 'call-1' } },
      { kind: 'adapter.reconnected', gameId: 'oni', detail: {} },
      { kind: 'voice.latency', gameId: 'oni', detail: { source: 'voice', asrMs: 80 } },
      { kind: 'agent.event', gameId: 'oni', detail: { eventType: 'done' } },
    ]
    expect(traces.filter(trace => traceMatchesFilter(trace, 'failures'))).toHaveLength(1)
    expect(traces.filter(trace => traceMatchesFilter(trace, 'timeouts'))).toHaveLength(1)
    expect(traces.filter(trace => traceMatchesFilter(trace, 'reconnects'))).toHaveLength(1)
    expect(traces.filter(trace => traceMatchesFilter(trace, 'voice'))).toHaveLength(1)
    expect(traces.filter(trace => traceMatchesFilter(trace, 'actions', 'call-1'))).toHaveLength(1)
  })

  it('creates a stable Windows-safe diagnostic filename', () => {
    expect(diagnosticFilename(new Date('2026-08-26T12:34:56.789Z'))).toBe('ai-native-game-harness-diagnostics_2026-08-26_12-34-56-789.json')
  })
})
