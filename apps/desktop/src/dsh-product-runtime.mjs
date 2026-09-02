import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const EMPTY_CORE_SNAPSHOT = Object.freeze({ adapters: [], observations: [], traces: [] })
const EMPTY_LEARNING_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  updatedAt: '',
  enabled: { memory: false, skills: false },
  memories: [],
  playStatistics: [],
  skills: [],
  skillAttempts: [],
})
const EMPTY_STORY_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  updatedAt: '',
  states: [],
  generationAttempts: [],
})
const PRODUCT_TURN_PREFIX = 'AI_GAME_HARNESS_PRODUCT_TURN_V1\n'
const WORK_RELAY_PREFIX = 'DSH_WORK_RELAY_V1'
const WORK_RELAY_META_PREFIX = 'DSH_WORK_META_V1'
const EMPTY_SESSION_STATS = Object.freeze({
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
})
const MAX_TRACES = 500
const CHAT_TIMEOUT_MS = 10 * 60_000
const STREAM_INITIAL_OPEN_TIMEOUT_MS = 30_000
const DIAGNOSTIC_KINDS = new Set(['game-agent.latency', 'voice.latency', 'voice.failed'])
const DIAGNOSTIC_DETAIL_KEYS = {
  'game-agent.latency': new Set(['source', 'provider', 'model', 'modelSelectionMs', 'captureMs', 'attachmentMs', 'agentReadyMs', 'firstTextMs', 'agentWaitMs', 'totalMs']),
  'voice.latency': new Set(['source', 'processId', 'asrMs', 'agentMs', 'ttsMs', 'totalMs', 'speechStreamed']),
  'voice.failed': new Set(['source', 'processId', 'stage', 'errorName', 'timeout', 'elapsedMs']),
}

function asErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function productTurnContent(message, gameId, { evaluation = false } = {}) {
  return [
    PRODUCT_TURN_PREFIX.trimEnd(),
    evaluation
      ? 'This is an isolated AI Native Game Harness product evaluation turn. Use only the selected evaluation Adapter and game_learning_skill_* tools required by the task; do not run memory, story, work, filesystem, shell, Mod detection, or installation tools.'
      : 'This is an AI Native Game Harness Desktop game turn.',
    gameId ? `GAME_ID:${gameId}` : undefined,
    evaluation ? 'EVALUATION_MODE:true' : undefined,
    evaluation ? undefined : 'Before answering, call game_learning_memory_recall exactly once with the original PLAYER_MESSAGE as query when that tool is available.',
    evaluation ? undefined : 'Use recalled memory only as possibly stale context. Current game observation and successful tool results are authoritative.',
    evaluation ? undefined : 'Call game_story_context exactly once when it is available. Treat its active beat as the current generated narrative goal.',
    evaluation ? undefined : 'When game_story_context returns needsGeneration=true, generate only 1 to 3 near-term StoryBeat-v1 objects and submit them with game_story_propose before narrating a new objective.',
    evaluation ? undefined : 'The story is dynamic, not a prewritten plot. Never claim a beat completed until Story Runtime has accepted Adapter Observation evidence.',
    evaluation ? undefined : 'Call game_story_choose only after the player explicitly selects one of the pending choices; never choose on their behalf.',
    'If the player asks you to learn a repeatable game procedure, call game_learning_skill_catalog before game_learning_skill_learn; only report it learned when learned=true.',
    'If the player asks to run a learned procedure, call game_learning_skill_catalog before game_learning_skill_run and only report success when success=true.',
    evaluation ? undefined : 'If the player requests substantial non-game work such as research, a presentation, HTML, a document, code, or an artifact revision, acknowledge it briefly but do not perform that work or call work tools in this turn. A post-turn work skill will decide whether to hand it to a separate Worker DSH Session. Do not claim that Worker has started or finished yet.',
    'PLAYER_MESSAGE:',
    message,
  ].filter(value => value !== undefined).join('\n')
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return text }
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .slice(0, 500)
}

/** Only public assistant text crosses into the product chat. */
export function visibleDshChunk(event) {
  if (event?.type !== 'assistant/chunk') return undefined
  const chunk = event.data?.chunk
  if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || !chunk.text) return undefined
  return { type: 'text-delta', text: chunk.text }
}

export function isWorkRelayUserEvent(event) {
  if (event?.type !== 'user/message'
    || event.data?.source?.kind !== 'plugin'
    || event.data.source.plugin !== 'dsh-work-orchestrator'
    || event.data.source.form !== 'relay') return false
  return contentText(event.data?.content).startsWith(WORK_RELAY_PREFIX)
}

export function workRelayMetadata(event) {
  if (!isWorkRelayUserEvent(event)) return undefined
  const line = contentText(event.data?.content)
    .split('\n')
    .find(candidate => candidate.startsWith(`${WORK_RELAY_META_PREFIX} `))
  if (!line) return undefined
  const value = safeJson(line.slice(WORK_RELAY_META_PREFIX.length + 1))
  if (!value || typeof value !== 'object') return undefined
  const workSessionId = typeof value.workSessionId === 'string' ? value.workSessionId.slice(0, 240) : ''
  const title = typeof value.title === 'string' ? value.title.slice(0, 120) : '后台工作'
  const status = typeof value.status === 'string' ? value.status.slice(0, 80) : '状态未知'
  const executor = value.executor === 'codex-app-server' ? 'codex-app-server' : 'dsh'
  const codexThreadId = typeof value.codexThreadId === 'string' ? value.codexThreadId.slice(0, 240) : undefined
  return { workSessionId, title, status, executor, ...(codexThreadId ? { codexThreadId } : {}) }
}

/** Validate the official DSH sessionStats projection before it reaches product IPC. */
export function normalizeSessionStats(value) {
  if (!value || typeof value !== 'object') return { ...EMPTY_SESSION_STATS }
  const normalized = {}
  for (const key of Object.keys(EMPTY_SESSION_STATS)) {
    const candidate = Number(value[key])
    normalized[key] = Number.isFinite(candidate) && candidate >= 0 ? candidate : 0
  }
  return normalized
}

function callContextKey(sessionId, callId) {
  return `${sessionId}\u0000${callId}`
}

function dshTraceFromEvent(event, sessionId, gameId, callContexts = new Map()) {
  let kind
  let detail
  switch (event?.type) {
    case 'turn/start':
      kind = 'dsh.turn.started'
      detail = { turn: event.data.turn }
      break
    case 'step/start':
      kind = 'dsh.step.started'
      detail = { turn: event.data.turn, step: event.data.step }
      break
    case 'step/end':
      kind = 'dsh.step.completed'
      detail = { turn: event.data.turn, step: event.data.step }
      break
    case 'tool/call':
      kind = 'dsh.tool.called'
      detail = {
        turn: event.data.turn,
        step: event.data.step,
        callId: String(event.data.callId),
        tool: event.data.name,
        arguments: safeJson(event.data.arguments),
      }
      callContexts.set(String(event.data.callId), detail)
      break
    case 'tool/result': {
      const callId = String(event.data.message?.source?.callId ?? event.data.message?.content?.[0]?.toolCallId ?? '')
      const isError = Boolean(event.data.error || event.data.message?.content?.[0]?.isError)
      kind = 'dsh.tool.result'
      detail = {
        turn: event.data.turn,
        step: event.data.step,
        callId,
        ok: !isError,
        ...(event.data.error?.code ? { errorCode: event.data.error.code } : {}),
        result: contentText(event.data.message?.content?.[0]?.content),
      }
      break
    }
    case 'tool/code-dispatch-start': {
      const callId = String(event.data.subCallId)
      const parentCallId = String(event.data.parentCallId)
      const parent = callContexts.get(parentCallId) ?? callContexts.get(String(event.data.rootCallId))
      kind = 'dsh.tool.called'
      detail = {
        ...(parent?.turn === undefined ? {} : { turn: parent.turn }),
        ...(parent?.step === undefined ? {} : { step: parent.step }),
        callId,
        parentCallId,
        rootCallId: String(event.data.rootCallId),
        tool: event.data.name,
        arguments: event.data.arguments,
        transport: 'code-mode',
      }
      callContexts.set(callId, detail)
      break
    }
    case 'tool/code-dispatch': {
      const callId = String(event.data.subCallId)
      const parentCallId = String(event.data.parentCallId)
      const context = callContexts.get(callId)
        ?? callContexts.get(parentCallId)
        ?? callContexts.get(String(event.data.rootCallId))
      kind = 'dsh.tool.result'
      detail = {
        ...(context?.turn === undefined ? {} : { turn: context.turn }),
        ...(context?.step === undefined ? {} : { step: context.step }),
        callId,
        parentCallId,
        rootCallId: String(event.data.rootCallId),
        ok: !event.data.isError,
        result: contentText(event.data.content),
        transport: 'code-mode',
      }
      break
    }
    case 'turn/end':
      kind = 'dsh.turn.completed'
      detail = { turn: event.data.turn, reason: event.data.reason?.kind ?? 'unknown' }
      break
    default:
      return undefined
  }
  return {
    traceId: `dsh:${sessionId}:${event.seq}`,
    sessionId,
    gameId,
    kind,
    createdAt: new Date(event.time ?? Date.now()).toISOString(),
    detail: { ...detail, seq: event.seq },
  }
}

/** Project DSH's durable event log without dropping its native turn/step identity. */
export function projectDshTraces(events, sessionId, gameId) {
  const callContexts = new Map()
  return events
    .map((event) => dshTraceFromEvent(event, sessionId, gameId, callContexts))
    .filter(Boolean)
}

/**
 * Join DSH Tool traces to Core/Adapter traces. DSH's callId is deliberately
 * reused as the game requestId by dsh-binding, so no timestamp guessing is
 * involved and concurrent calls remain distinguishable.
 */
export function correlateDshGameTraces(coreTraces, sessionTraces) {
  const contexts = new Map()
  for (const trace of sessionTraces) {
    if (trace.kind !== 'dsh.tool.called' && trace.kind !== 'dsh.tool.result') continue
    const callId = String(trace.detail?.callId ?? '')
    if (!callId) continue
    const previous = contexts.get(callContextKey(trace.sessionId, callId)) ?? {}
    contexts.set(callContextKey(trace.sessionId, callId), {
      ...previous,
      ...(trace.detail?.turn === undefined ? {} : { turn: trace.detail.turn }),
      ...(trace.detail?.step === undefined ? {} : { step: trace.detail.step }),
      ...(trace.detail?.parentCallId === undefined ? {} : { parentCallId: trace.detail.parentCallId }),
      ...(trace.detail?.rootCallId === undefined ? {} : { rootCallId: trace.detail.rootCallId }),
    })
  }

  return coreTraces.map((trace) => {
    const rawCallId = trace.detail?.callId ?? trace.detail?.requestId
    if (rawCallId === undefined || rawCallId === null || rawCallId === '') return trace
    const callId = String(rawCallId)
    const context = contexts.get(callContextKey(trace.sessionId, callId))
    if (!context) return trace
    return {
      ...trace,
      detail: {
        ...trace.detail,
        callId,
        ...context,
      },
    }
  })
}

export function normalizeProductDiagnostic(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !DIAGNOSTIC_KINDS.has(value.kind)) return undefined
  const detail = {}
  const allowedDetailKeys = DIAGNOSTIC_DETAIL_KEYS[value.kind]
  if (value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail)) {
    for (const [key, candidate] of Object.entries(value.detail)) {
      if (!allowedDetailKeys.has(key)) continue
      if (typeof candidate === 'number' && Number.isFinite(candidate)) detail[key] = Math.max(0, candidate)
      else if (typeof candidate === 'boolean') detail[key] = candidate
      else if (typeof candidate === 'string') detail[key] = candidate.slice(0, 200)
    }
  }
  const id = typeof value.id === 'string' && value.id ? value.id.slice(0, 200) : randomUUID()
  const createdAt = typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    ? new Date(value.createdAt).toISOString()
    : new Date().toISOString()
  return {
    id,
    kind: value.kind,
    createdAt,
    sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId.slice(0, 200) : undefined,
    gameId: typeof value.gameId === 'string' && value.gameId ? value.gameId.slice(0, 200) : undefined,
    interactionId: typeof value.interactionId === 'string' && value.interactionId ? value.interactionId.slice(0, 200) : undefined,
    detail,
  }
}

export class DshProductRuntime {
  #baseUrl
  #cwd
  #adapterUrl
  #fetch
  #WebSocket
  #sessionId
  #agentPreset
  #coreSnapshot = EMPTY_CORE_SNAPSHOT
  #learningSnapshot = EMPTY_LEARNING_SNAPSHOT
  #storySnapshot = EMPTY_STORY_SNAPSHOT
  #sessionTraces = []
  #listeners = new Set()
  #streamTasks = []
  #sockets = new Set()
  #stopped = true
  #muxConnected = false
  #hostConnected = false
  #agentRunning = false
  #reconnectCount = 0
  #pendingChat
  #sessionStats = { ...EMPTY_SESSION_STATS }
  #sessionStatsSource = 'unavailable'
  #projectionSeq = -1
  #lastSessionSeq = -1
  #refreshTask
  #callContexts = new Map()
  #pendingWorkRelay = false
  #pendingWorkRelayMetadata
  #workRelayTurns = new Map()
  #notifications = []
  #forceNewSession

  constructor({ baseUrl, cwd, adapterUrl, forceNewSession = false, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
    this.#baseUrl = baseUrl.replace(/\/$/, '')
    this.#cwd = cwd
    this.#adapterUrl = adapterUrl
    this.#fetch = fetchImpl
    this.#WebSocket = WebSocketImpl
    this.#forceNewSession = forceNewSession
  }

  async start() {
    if (!this.#stopped) return this.info()
    this.#stopped = false
    try {
      await Promise.all([
        this.#startStream('/api/events.mux', (frame) => this.#handleMuxFrame(frame), 'mux'),
        this.#startStream('/api/events.host', (frame) => this.#handleHostFrame(frame), 'host'),
      ])
      const listed = this.#forceNewSession ? { items: [] } : await this.#rpc('session.list', {})
      const reusable = listed.items?.find((item) => item.blank === true && item.running === false && item.cwd === this.#cwd)
      if (reusable) {
        this.#sessionId = reusable.sessionId
        this.#agentPreset = reusable.agentPreset
      } else {
        const created = await this.#rpc('session.create', { cwd: this.#cwd })
        this.#sessionId = created.sessionId
        this.#agentPreset = created.agentPreset
      }
      await this.#refreshSessionState()
      this.#publish()
      return this.info()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  info() {
    return {
      runtime: 'dsh',
      baseUrl: this.#baseUrl,
      sessionId: this.#sessionId,
      agentPreset: this.#agentPreset,
      adapterUrl: this.#adapterUrl,
      cwd: this.#cwd,
    }
  }

  snapshot() {
    const coreTraces = correlateDshGameTraces(this.#coreSnapshot.traces, this.#sessionTraces)
    const traces = [...coreTraces, ...this.#sessionTraces]
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .slice(-MAX_TRACES)
    return structuredClone({
      ...this.#coreSnapshot,
      learning: this.#learningSnapshot,
      story: this.#storySnapshot,
      traces,
      runtime: {
        kind: 'dsh',
        label: 'AI Native Game Harness Session',
        status: this.#muxConnected && this.#hostConnected ? 'online' : 'reconnecting',
        sessionId: this.#sessionId,
        agentPreset: this.#agentPreset,
        agentRunning: this.#agentRunning,
        reconnectCount: this.#reconnectCount,
        adapterUrl: this.#adapterUrl,
        sessionStats: this.#sessionStats,
        sessionStatsSource: this.#sessionStatsSource,
        hiddenReasoning: 'not-exposed',
        directActions: false,
        notifications: structuredClone(this.#notifications),
      },
    })
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async modelSelection() {
    if (!this.#sessionId) throw new Error('AI Native Game Harness Session 尚未创建。')
    const models = await this.#rpc('session.models', { sessionId: this.#sessionId })
    return structuredClone(models.current)
  }

  async selectModel(selection) {
    if (!this.#sessionId) throw new Error('AI Native Game Harness Session 尚未创建。')
    if (!selection?.provider || !selection?.model) throw new Error('模型选择无效。')
    const selected = await this.#rpc('session.selectModel', {
      sessionId: this.#sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
    return structuredClone(selected.selected)
  }

  attachCoreSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.adapters) || !Array.isArray(snapshot.observations) || !Array.isArray(snapshot.traces)) return
    this.#coreSnapshot = structuredClone(snapshot)
    this.#publish()
  }

  attachLearningSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || !snapshot.enabled
      || !Array.isArray(snapshot.memories) || !Array.isArray(snapshot.skills)
      || !Array.isArray(snapshot.skillAttempts) || !Array.isArray(snapshot.playStatistics)) return
    this.#learningSnapshot = structuredClone(snapshot)
    this.#publish()
  }

  attachStorySnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1
      || !Array.isArray(snapshot.states) || !Array.isArray(snapshot.generationAttempts)) return
    this.#storySnapshot = structuredClone(snapshot)
    this.#publish()
  }

  attachDiagnosticRecord(value) {
    const record = normalizeProductDiagnostic(value)
    if (!record) return false
    this.#appendSessionTrace({
      traceId: `diagnostic:${record.id}`,
      sessionId: record.sessionId ?? this.#sessionId ?? 'dsh-diagnostic',
      gameId: record.gameId ?? this.#coreSnapshot.adapters.find((adapter) => adapter.status === 'connected')?.gameId ?? 'dsh-session',
      kind: record.kind,
      createdAt: record.createdAt,
      detail: {
        ...record.detail,
        ...(record.interactionId === undefined ? {} : { interactionId: record.interactionId }),
      },
    })
    return true
  }

  async chat({ message, gameId, evaluation = false }, onEvent = () => undefined) {
    if (!this.#sessionId) throw new Error('AI Native Game Harness Session 尚未创建。')
    if (this.#pendingChat) throw new Error('AI Native Game Harness Session 正在处理上一条消息。')

    const events = []
    const emit = (event) => {
      events.push(event)
      onEvent(event)
    }
    let resolveTurn
    let rejectTurn
    const turn = new Promise((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    const timeout = setTimeout(() => rejectTurn(new Error('等待 AI Native Game Harness Session 完成超时。')), CHAT_TIMEOUT_MS)
    this.#pendingChat = { emit, resolve: resolveTurn, reject: rejectTurn, publicText: '' }
    try {
      const result = await this.#rpc('session.prompt', {
        sessionId: this.#sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: productTurnContent(message, gameId, { evaluation }) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      if (result.command) {
        emit({ type: 'done', text: result.command.text ?? '命令已执行。' })
        resolveTurn()
      }
      await turn
      return { events, snapshot: this.snapshot() }
    } catch (error) {
      resolveTurn()
      throw error
    } finally {
      clearTimeout(timeout)
      this.#pendingChat = undefined
      this.#publish()
    }
  }

  async reset() {
    throw new Error('AI Native Game Harness 产品链路不允许页面绕过 Agent 直接调用游戏动作。')
  }

  async close() {
    this.#stopped = true
    if (this.#pendingChat && this.#sessionId) {
      await this.#rpc('session.cancel', { sessionId: this.#sessionId }).catch(() => undefined)
    }
    this.#pendingChat?.reject(new Error('AI Runtime 已停止。'))
    for (const socket of this.#sockets) socket.close()
    await Promise.allSettled(this.#streamTasks)
    this.#streamTasks = []
    this.#sockets.clear()
  }

  async #rpc(method, payload) {
    const rpcId = randomUUID()
    const response = await this.#fetch(`${this.#baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`AI Runtime ${method} 请求失败：HTTP ${response.status}`)
    const envelope = await response.json()
    if (envelope?.rpcId !== rpcId) throw new Error(`AI Runtime ${method} 返回了错误的 rpcId。`)
    if (!envelope?.result?.ok) {
      const error = envelope?.result?.error
      throw new Error(`AI Runtime ${method} 失败${error?.code ? ` [${error.code}]` : ''}：${error?.message ?? '未知错误'}`)
    }
    return envelope.result.value
  }

  #startStream(path, onFrame, channel) {
    let settleOpen
    let rejectOpen
    let opened = false
    const initialOpen = new Promise((resolve, reject) => {
      settleOpen = resolve
      rejectOpen = reject
    })
    const openTimeout = setTimeout(() => {
      rejectOpen(new Error(`AI Runtime ${channel} 事件流连接超时。`))
    }, STREAM_INITIAL_OPEN_TIMEOUT_MS)
    const task = this.#runStream(path, onFrame, channel, () => {
      if (!opened) {
        opened = true
        clearTimeout(openTimeout)
        settleOpen()
      }
    }, (error) => {
      this.#appendTrace('dsh.stream.open-failed', { channel, error: asErrorMessage(error) })
    })
    this.#streamTasks.push(task)
    return initialOpen.finally(() => clearTimeout(openTimeout))
  }

  async #runStream(path, onFrame, channel, onFirstOpen, onFirstError) {
    let firstAttempt = true
    while (!this.#stopped) {
      try {
        await this.#openStream(path, onFrame, () => {
          if (channel === 'mux') this.#muxConnected = true
          if (channel === 'host') this.#hostConnected = true
          onFirstOpen()
          this.#publish()
          if (this.#sessionId && this.#muxConnected && this.#hostConnected) {
            void this.#refreshSessionState().catch((error) => {
              this.#appendTrace('dsh.bridge.refresh-failed', { error: asErrorMessage(error) })
            })
          }
        })
      } catch (error) {
        if (firstAttempt) onFirstError(error)
      }
      firstAttempt = false
      if (channel === 'mux') this.#muxConnected = false
      if (channel === 'host') this.#hostConnected = false
      if (this.#stopped) break
      this.#reconnectCount += 1
      this.#publish()
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 150 * this.#reconnectCount)))
    }
  }

  #openStream(path, onFrame, onOpen) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.#baseUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new this.#WebSocket(url)
      this.#sockets.add(socket)
      let opened = false
      socket.once('open', () => {
        opened = true
        onOpen()
      })
      socket.on('message', (data) => {
        try {
          const envelope = JSON.parse(typeof data === 'string' ? data : data.toString())
          if (envelope?.type === 'server-request' && envelope.payload) onFrame(envelope.payload)
        } catch (error) {
          this.#appendTrace('dsh.stream.invalid', { channel: path, error: asErrorMessage(error) })
        }
      })
      socket.once('error', (error) => {
        if (!opened) reject(error)
      })
      socket.once('close', () => {
        this.#sockets.delete(socket)
        resolve()
      })
    })
  }

  #handleMuxFrame(frame) {
    if (frame?.type === 'stream/error') {
      this.#appendTrace('dsh.stream.error', { code: frame.error?.code ?? 'UNKNOWN', message: frame.error?.message ?? '未知错误' })
      return
    }
    if (!this.#sessionId || frame?.sessionId !== this.#sessionId) return
    if (frame.type === 'session/projection') {
      if (frame.key === 'sessionStats' && frame.seq >= this.#projectionSeq) {
        this.#projectionSeq = frame.seq
        this.#sessionStats = normalizeSessionStats(frame.value)
        this.#sessionStatsSource = 'dsh-sessionStats'
        this.#publish()
      }
      return
    }
    if (frame.type !== 'session/event') return
    const event = frame.event
    if (typeof event?.seq === 'number' && event.seq <= this.#lastSessionSeq) return
    if (typeof event?.seq === 'number') this.#lastSessionSeq = event.seq
    const gameId = this.#coreSnapshot.adapters.find((adapter) => adapter.status === 'connected')?.gameId ?? 'dsh-session'
    const trace = dshTraceFromEvent(event, this.#sessionId, gameId, this.#callContexts)
    if (trace) this.#appendSessionTrace(trace)
    this.#handlePendingSessionEvent(event)
  }

  #handlePendingSessionEvent(event) {
    if (isWorkRelayUserEvent(event)) {
      this.#pendingWorkRelay = true
      this.#pendingWorkRelayMetadata = workRelayMetadata(event)
      return
    }
    if (event?.type === 'turn/start' && this.#pendingWorkRelay) {
      this.#pendingWorkRelay = false
      this.#workRelayTurns.set(event.data.turn, this.#pendingWorkRelayMetadata)
      this.#pendingWorkRelayMetadata = undefined
    }
    const workRelay = this.#workRelayTurns.has(event?.data?.turn)
    const workMetadata = this.#workRelayTurns.get(event?.data?.turn)
    const visible = visibleDshChunk(event)
    if (visible && this.#pendingChat && !workRelay) {
      this.#pendingChat.publicText += visible.text
      this.#pendingChat.emit(visible)
    }

    switch (event?.type) {
      case 'tool/call':
        this.#pendingChat?.emit({ type: 'tool-call', callId: String(event.data.callId), tool: event.data.name })
        break
      case 'tool/result': {
        const callId = String(event.data.message?.source?.callId ?? event.data.message?.content?.[0]?.toolCallId ?? '')
        const isError = Boolean(event.data.error || event.data.message?.content?.[0]?.isError)
        this.#pendingChat?.emit({ type: 'tool-result', callId, ok: !isError, errorCode: event.data.error?.code })
        break
      }
      case 'assistant/message': {
        if (workRelay) {
          const text = contentText(event.data.message?.content)
          const id = `work-relay:${this.#sessionId ?? 'unknown'}:${event.seq ?? randomUUID()}`
          if (text && !this.#notifications.some(item => item.id === id)) {
            this.#notifications.push({
              id,
              text,
              createdAt: new Date(event.time ?? Date.now()).toISOString(),
              ...(workMetadata ?? {}),
            })
            if (this.#notifications.length > 30) this.#notifications.shift()
            this.#publish()
          }
        } else if (this.#pendingChat && !this.#pendingChat.publicText) {
          const text = contentText(event.data.message?.content)
          if (text) {
            this.#pendingChat.publicText = text
            this.#pendingChat.emit({ type: 'text-delta', text })
          }
        }
        break
      }
      case 'turn/end': {
        if (workRelay) {
          this.#workRelayTurns.delete(event.data.turn)
        } else {
          this.#pendingChat?.emit({ type: 'done', text: '' })
          this.#pendingChat?.resolve()
        }
        break
      }
    }
  }

  #handleHostFrame(frame) {
    if (!this.#sessionId || frame?.sessionId !== this.#sessionId) return
    if (frame.type === 'host/session-status') {
      this.#agentRunning = Boolean(frame.running)
      this.#publish()
    }
    if (frame.type === 'host/agent-error') {
      this.#appendTrace('dsh.agent.error', { message: frame.message ?? '未知错误' })
      this.#pendingChat?.reject(new Error(frame.message ?? 'AI Agent 运行失败。'))
    }
  }

  #appendTrace(kind, detail, sourceEvent) {
    this.#appendSessionTrace({
      traceId: randomUUID(),
      sessionId: this.#sessionId ?? 'dsh-startup',
      gameId: this.#coreSnapshot.adapters.find((adapter) => adapter.status === 'connected')?.gameId ?? 'dsh-session',
      kind,
      createdAt: new Date(sourceEvent?.time ?? Date.now()).toISOString(),
      detail: {
        ...detail,
        ...(sourceEvent?.seq === undefined ? {} : { seq: sourceEvent.seq }),
      },
    })
  }

  #appendSessionTrace(trace) {
    const existing = this.#sessionTraces.findIndex((candidate) => candidate.traceId === trace.traceId)
    if (existing >= 0) this.#sessionTraces[existing] = trace
    else this.#sessionTraces.push(trace)
    if (this.#sessionTraces.length > MAX_TRACES) this.#sessionTraces.shift()
    this.#publish()
  }

  #refreshSessionState() {
    if (!this.#sessionId) return Promise.resolve()
    if (this.#refreshTask) return this.#refreshTask
    this.#refreshTask = (async () => {
      const history = await this.#rpc('session.history', { sessionId: this.#sessionId, maxMessages: 200 })
      const events = Array.isArray(history.events)
        ? history.events.map((entry) => entry?.event).filter((event) => event && typeof event.seq === 'number')
        : []
      const gameId = this.#coreSnapshot.adapters.find((adapter) => adapter.status === 'connected')?.gameId ?? 'dsh-session'
      this.#callContexts = new Map()
      const historyTraces = events
        .map((event) => dshTraceFromEvent(event, this.#sessionId, gameId, this.#callContexts))
        .filter(Boolean)
      const historyMaxSeq = events.reduce((max, event) => Math.max(max, event.seq), -1)
      const newerLiveTraces = this.#sessionTraces.filter((trace) => Number(trace.detail?.seq) > historyMaxSeq)
      this.#sessionTraces = [...historyTraces, ...newerLiveTraces].slice(-MAX_TRACES)
      for (const trace of newerLiveTraces) {
        if (trace.kind === 'dsh.tool.called' && trace.detail?.callId) {
          this.#callContexts.set(String(trace.detail.callId), trace.detail)
        }
      }

      const unseenBoundary = this.#lastSessionSeq
      for (const event of events) {
        if (event.seq > unseenBoundary) this.#handlePendingSessionEvent(event)
      }
      this.#lastSessionSeq = Math.max(this.#lastSessionSeq, historyMaxSeq)

      const projectionSeq = Number(history.projections?.asOfSeq)
      if (Number.isFinite(projectionSeq) && projectionSeq >= this.#projectionSeq) {
        this.#projectionSeq = projectionSeq
        this.#sessionStats = normalizeSessionStats(history.projections?.values?.sessionStats)
        this.#sessionStatsSource = history.projections?.values?.sessionStats === undefined
          ? 'unavailable'
          : 'dsh-sessionStats'
      }
      this.#publish()
    })().finally(() => {
      this.#refreshTask = undefined
    })
    return this.#refreshTask
  }

  #publish() {
    if (!this.#listeners.size) return
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }
}
