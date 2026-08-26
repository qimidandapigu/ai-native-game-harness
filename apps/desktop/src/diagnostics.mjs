const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)/i
const PRIVATE_REASONING_KEY = /^(?:analysis|reasoning|chain[-_]?of[-_]?thought)$/i
const PRIVATE_CONVERSATION_KEY = /^(?:prompt|transcript|conversation|chatMessages|userMessage|assistantMessage|inputText|outputText)$/i
const MAX_STRING_LENGTH = 2_000
const MAX_ARRAY_LENGTH = 200
const MAX_DEPTH = 8

function sanitizedString(value) {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`
}

export function sanitizeDiagnosticValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (PRIVATE_REASONING_KEY.test(key)) return '[OMITTED]'
  if (PRIVATE_CONVERSATION_KEY.test(key)) return '[OMITTED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return sanitizedString(value)
  if (typeof value === 'bigint') return String(value)
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]'
  if (typeof value !== 'object') return sanitizedString(String(value))
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => sanitizeDiagnosticValue(item, key, depth + 1, seen))
    }
    const result = {}
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const sanitized = sanitizeDiagnosticValue(entryValue, entryKey, depth + 1, seen)
      if (sanitized !== undefined) result[entryKey] = sanitized
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function buildDiagnosticBundle(snapshot, metadata = {}) {
  const runtime = snapshot?.runtime ?? {}
  const { gamePacks = [], ...productMetadata } = metadata
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    product: sanitizeDiagnosticValue({
      name: 'AI Native Game Harness',
      runtimeKind: runtime.kind,
      runtimeLabel: runtime.label,
      ...productMetadata,
    }),
    runtime: sanitizeDiagnosticValue(runtime),
    adapters: sanitizeDiagnosticValue(snapshot?.adapters ?? []),
    gamePacks: sanitizeDiagnosticValue(gamePacks),
    observations: sanitizeDiagnosticValue(snapshot?.observations ?? []),
    traces: (snapshot?.traces ?? [])
      .slice(-500)
      .map((trace) => sanitizeDiagnosticValue(trace)),
  }
}

export function diagnosticFilename(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return `ai-native-game-harness-diagnostics_${stamp}.json`
}

function isFailure(trace) {
  const detail = trace?.detail ?? {}
  return detail.ok === false
    || Boolean(detail.errorCode)
    || String(trace?.kind ?? '').includes('error')
    || String(detail.status ?? '') === 'failed'
}

export function traceMatchesFilter(trace, filter = 'all', search = '') {
  const detail = trace?.detail ?? {}
  let matches = true
  switch (filter) {
    case 'failures':
      matches = isFailure(trace)
      break
    case 'timeouts':
      matches = /timeout/i.test(`${trace?.kind ?? ''} ${detail.errorCode ?? ''} ${detail.stage ?? ''}`)
      break
    case 'reconnects':
      matches = ['adapter.disconnected', 'adapter.reconnected', 'dsh.stream.error', 'dsh.stream.invalid'].includes(trace?.kind)
      break
    case 'voice':
      matches = ['voice.latency', 'game-agent.latency'].includes(trace?.kind) || detail.source === 'voice'
      break
    case 'actions':
      matches = ['action.executed', 'dsh.tool.called', 'dsh.tool.result'].includes(trace?.kind)
        || ['action', 'action-result'].includes(detail.eventType)
      break
    case 'all':
      break
    default:
      matches = false
  }
  if (!matches) return false
  const needle = String(search).trim().toLocaleLowerCase('zh-CN')
  if (!needle) return true
  return JSON.stringify(sanitizeDiagnosticValue(trace)).toLocaleLowerCase('zh-CN').includes(needle)
}
