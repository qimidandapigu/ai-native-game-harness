import { buildGameViewModel, safeStatePreview } from './game-view-models.mjs'
import { buildDiagnosticBundle, diagnosticFilename, traceMatchesFilter } from './diagnostics.mjs'

const pages = {
  chat: { title: '与游戏一起思考' },
  story: { title: '生成正在发生的故事' },
  learning: { title: '看见伙伴学会了什么' },
  evaluation: { title: '自动验证 Agent 能不能真的做到' },
  analysis: { title: '看清每一步决策' },
  adapters: { title: '管理游戏连接' },
}

const fallback = {
  adapters: [],
  observations: [],
  traces: [],
  learning: {
    schemaVersion: 1,
    enabled: { memory: false, skills: false },
    memories: [], playStatistics: [], skills: [], skillAttempts: [],
  },
  story: {
    schemaVersion: 1,
    states: [], generationAttempts: [],
  },
  runtime: {
    kind: 'standalone',
    label: 'Harness Core',
    status: 'starting',
    reconnectCount: 0,
    hiddenReasoning: 'not-exposed',
    directActions: true,
    notifications: [],
  },
}

const placeholderObservation = { gameId: '', saveId: 'default', revision: 0, state: {} }

let snapshot = structuredClone(fallback)
let busy = false
let selectedGameId
let gamePacks = []
let traceFilter = 'all'
let traceSearch = ''
let evaluationState = { catalog: [], currentModel: undefined, running: false, progress: '尚未运行', result: undefined }
const seenRuntimeNotifications = new Set()
const $ = (selector) => document.querySelector(selector)

function setPage(name) {
  document.querySelectorAll('.page').forEach((item) => item.classList.toggle('active', item.id === `page-${name}`))
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.page === name
    item.classList.toggle('active', active)
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current')
  })
  $('#page-title').textContent = pages[name].title
  $('.sidebar').classList.remove('open')
}

async function api(path, options, onEvent) {
  const platform = window.harnessDesktop?.platform
  if (platform) {
    if (path === '/api/snapshot') return await platform.snapshot()
    if (path === '/api/chat') return await platform.chat(JSON.parse(options?.body ?? '{}'), onEvent)
    if (path === '/api/reset') return await platform.reset(activeAdapter()?.gameId)
    throw new Error(`未知 Desktop API：${path}`)
  }
  try {
    const response = await fetch(path, options)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    if (location.protocol !== 'file:') throw error
    return null
  }
}

function observation() {
  const gameId = activeAdapter()?.gameId
  return snapshot.observations.find((item) => item.gameId === gameId) ?? placeholderObservation
}

function activeAdapter() {
  const selected = snapshot.adapters.find((item) => item.gameId === selectedGameId)
  if (selected) return selected
  const next = snapshot.adapters.find((item) => item.status === 'connected') ?? snapshot.adapters[0]
  selectedGameId = next?.gameId
  return next
}

function render() {
  const adapter = activeAdapter()
  const current = observation()
  const runtime = snapshot.runtime ?? fallback.runtime
  const connected = adapter?.status === 'connected'
  $('#game-name').textContent = adapter?.displayName ?? '等待游戏连接'
  $('#live-status').textContent = connected ? 'LIVE' : adapter ? 'OFFLINE' : 'WAIT'
  $('#revision-badge').textContent = adapter ? `REV ${current.revision}` : 'NO GAME'
  renderGameState(adapter, current)
  renderStory(adapter, current)
  renderLearning(adapter, current)
  $('#metric-adapters').textContent = snapshot.adapters.filter((item) => item.status === 'connected').length
  $('#metric-revision').textContent = adapter ? current.revision : '—'
  const sessionStats = runtime.sessionStats ?? {}
  const llmMs = Number(sessionStats.llmMs)
  const toolMs = Number(sessionStats.toolMs)
  const ttftMs = Number(sessionStats.ttftMs)
  const ttftSteps = Number(sessionStats.ttftSteps)
  $('#metric-llm').textContent = `${Number.isFinite(llmMs) ? Math.round(llmMs) : 0}ms`
  $('#metric-tool').textContent = `${Number.isFinite(toolMs) ? Math.round(toolMs) : 0}ms`
  $('#metric-ttft').textContent = Number.isFinite(ttftMs) && Number.isFinite(ttftSteps) && ttftSteps > 0
    ? `AI Runtime 统计 · 平均首字 ${Math.round(ttftMs / ttftSteps)}ms`
    : 'AI Runtime 统计 · 尚无首字'
  const latestAction = snapshot.traces.findLast?.(trace => trace.kind === 'action.executed')
    ?? [...snapshot.traces].reverse().find(trace => trace.kind === 'action.executed')
  setMeasuredMetric('#metric-core-action', latestAction?.detail?.coreValidationMs)
  setMeasuredMetric('#metric-adapter-action', latestAction?.detail?.adapterRoundTripMs)
  setMeasuredMetric('#metric-bridge-action', latestAction?.detail?.bridgeRoundTripMs)
  setMeasuredMetric('#metric-game-action', latestAction?.detail?.gameExecutionMs)
  const latestVoice = [...snapshot.traces].reverse().find(trace => trace.kind === 'voice.latency')
  const latestGameAgent = [...snapshot.traces].reverse().find(trace => trace.kind === 'game-agent.latency')
  setMeasuredMetric('#metric-asr', latestVoice?.detail?.asrMs)
  setMeasuredMetric('#metric-first-text', latestGameAgent?.detail?.firstTextMs)
  setMeasuredMetric('#metric-tts', latestVoice?.detail?.ttsMs)
  setMeasuredMetric('#metric-voice-total', latestVoice?.detail?.totalMs)
  $('#runtime-name').textContent = `${runtime.label ?? 'Harness Runtime'} ${runtime.status === 'online' ? '在线' : '连接中'}`
  $('#runtime-meta').textContent = runtime.sessionId ? `Session ${runtime.sessionId}` : 'Protocol 1.0 · Local runtime'
  $('#runtime-agent').textContent = runtime.label ?? runtime.kind ?? 'Harness Runtime'
  $('#runtime-session').textContent = runtime.sessionId ?? 'Standalone Session'
  $('#runtime-status').textContent = runtime.agentRunning ? 'Agent 运行中' : runtime.status === 'online' ? '已连接' : '正在重连'
  $('#runtime-reconnects').textContent = runtime.reconnectCount ?? 0
  const canReset = runtime.directActions !== false && connected && (adapter?.capabilities ?? []).some((capability) => capability.kind === 'action' && capability.name === 'game.reset')
  $('#reset-game').disabled = !canReset
  $('#reset-game').hidden = !canReset
  $('#reset-game').textContent = adapter ? `重置 ${adapter.displayName}` : '重置游戏'
  renderTraces()
  renderAdapters()
  renderGamePacks()
}

function learningEmpty(text) {
  const empty = document.createElement('div')
  empty.className = 'empty learning-empty'
  empty.textContent = text
  return empty
}

function learningRow(title, detail, meta, tone) {
  const row = document.createElement('article')
  row.className = `learning-row${tone ? ` ${tone}` : ''}`
  const body = document.createElement('div')
  const heading = document.createElement('strong')
  heading.textContent = title
  const text = document.createElement('p')
  text.textContent = detail
  body.append(heading, text)
  const badge = document.createElement('span')
  badge.textContent = meta
  row.append(body, badge)
  return row
}

function storyStatus(status) {
  return ({
    'needs-generation': '等待生成',
    active: '进行中',
    'awaiting-choice': '等待选择',
    ended: '已结束',
  })[status] ?? '等待'
}

function conditionText(condition) {
  if (!condition) return '未提供'
  return `${condition.path} ${condition.operator} ${JSON.stringify(condition.value)}`
}

function renderStory(adapter, current) {
  const story = snapshot.story ?? fallback.story
  const gameId = adapter?.gameId
  const saveId = current?.saveId ?? 'default'
  const state = (story.states ?? []).find(item => item.gameId === gameId && item.saveId === saveId)
  const attempts = (story.generationAttempts ?? []).filter(item => !gameId || item.gameId === gameId)
  const rejected = attempts.filter(item => !item.accepted)
  $('#story-status').textContent = storyStatus(state?.status)
  $('#story-save-id').textContent = gameId ? `${gameId} / ${saveId}` : '等待游戏存档'
  $('#story-queued-count').textContent = state?.queuedBeats?.length ?? 0
  $('#story-history-count').textContent = state?.history?.length ?? 0
  $('#story-attempt-count').textContent = attempts.length
  $('#story-rejected-count').textContent = `${rejected.length} 次被拒绝`
  $('#story-revision').textContent = `REV ${state?.revision ?? 0}`

  const activeRoot = $('#story-active')
  activeRoot.replaceChildren()
  if (!state?.activeBeat) {
    activeRoot.append(learningEmpty(gameId
      ? state?.status === 'ended' ? '这个存档的动态故事已经结束。' : '当前没有活动片段。点击“生成或继续剧情”，由 AI Native Game Harness Session 根据最新游戏事实生成。'
      : '连接游戏后才会按 gameId + saveId 生成和保存剧情。'))
  } else {
    const beat = state.activeBeat
    const title = document.createElement('h3')
    title.textContent = beat.title
    const premise = document.createElement('p')
    premise.textContent = beat.premise
    const goal = document.createElement('div')
    goal.className = 'story-goal'
    const goalLabel = document.createElement('span')
    goalLabel.textContent = '当前目标'
    const goalText = document.createElement('strong')
    goalText.textContent = beat.goal
    goal.append(goalLabel, goalText)
    const proof = document.createElement('div')
    proof.className = 'story-proof'
    proof.textContent = `完成证据：${conditionText(beat.completion)}`
    activeRoot.append(title, premise, goal)
    if (beat.characterMotivation) {
      const motivation = document.createElement('p')
      motivation.className = 'story-motivation'
      motivation.textContent = `角色动机：${beat.characterMotivation}`
      activeRoot.append(motivation)
    }
    activeRoot.append(proof)
  }

  const threadRoot = $('#story-threads')
  threadRoot.replaceChildren()
  const choices = state?.pendingChoices ?? []
  const threads = state?.openThreads ?? []
  if (!choices.length && !threads.length) threadRoot.append(learningEmpty('当前没有等待玩家决定的分支，也没有待续线索。'))
  for (const choice of choices) threadRoot.append(learningRow(choice.label, choice.direction, `选择 ${choice.id}`))
  for (const [index, thread] of threads.entries()) threadRoot.append(learningRow(`待续线索 ${index + 1}`, thread, '下一次生成可继续'))

  const historyRoot = $('#story-history')
  historyRoot.replaceChildren()
  const history = [...(state?.history ?? [])].reverse()
  if (!history.length) historyRoot.append(learningEmpty('还没有被 Adapter 事实证明完成或失败的剧情片段。'))
  for (const item of history) historyRoot.append(learningRow(
    item.beat.title,
    `${item.beat.goal} · 证据 REV ${item.evidence.observationRevision}：${conditionText(item.evidence.condition)}`,
    item.outcome === 'completed' ? '已完成' : '已失败',
    item.outcome === 'completed' ? 'success' : 'failure',
  ))
}

function renderLearning(adapter, current) {
  const learning = snapshot.learning ?? fallback.learning
  const gameId = adapter?.gameId
  const saveId = current?.saveId ?? 'default'
  const memories = (learning.memories ?? []).filter(item => item.gameId === gameId && item.saveId === saveId && item.status === 'active')
  const skills = (learning.skills ?? []).filter(item => item.gameId === gameId && item.status === 'active')
  const attempts = (learning.skillAttempts ?? []).filter(item => !gameId || item.gameId === gameId).slice(-20).reverse()
  const failures = attempts.filter(item => !item.success)
  $('#learning-memory-count').textContent = memories.length
  $('#learning-skill-count').textContent = skills.length
  $('#learning-failed-count').textContent = failures.length
  $('#learning-save-id').textContent = gameId ? `${gameId} / ${saveId}` : '等待游戏存档'
  $('#learning-memory-status').textContent = learning.enabled?.memory ? '自动学习已开启' : '记忆未启用'
  $('#learning-skill-status').textContent = learning.enabled?.skills ? '真实试跑门禁' : '技能未启用'

  const memoryRoot = $('#learning-memory-list')
  memoryRoot.replaceChildren()
  if (!memories.length) memoryRoot.append(learningEmpty(gameId ? '当前存档还没有长期记忆。完成对话后会在后台提取值得保留的内容。' : '连接游戏后按 gameId + saveId 展示记忆。'))
  for (const memory of memories) memoryRoot.append(learningRow(memory.subject, memory.summary, `${memory.kind} · 重要度 ${memory.importance}`))

  const skillRoot = $('#learning-skill-list')
  skillRoot.replaceChildren()
  if (!skills.length) skillRoot.append(learningEmpty(gameId ? '还没有通过真实试跑的技能。失败候选不会显示在这里。' : '连接游戏后展示该游戏的已学技能。'))
  for (const skill of skills) {
    const triggers = (skill.triggers ?? []).join('、') || '无触发词'
    skillRoot.append(learningRow(skill.name, `${skill.description} · 触发：${triggers}`, `v${skill.version} · 成功 ${skill.successCount} / 失败 ${skill.failureCount}`))
  }

  const attemptRoot = $('#learning-attempt-list')
  attemptRoot.replaceChildren()
  if (!attempts.length) attemptRoot.append(learningEmpty('还没有技能学习尝试。'))
  for (const attempt of attempts) {
    attemptRoot.append(learningRow(
      `${attempt.skillId} · 候选 v${attempt.proposedVersion}`,
      attempt.success ? '真实试跑完整成功，已允许保存。' : `真实试跑失败：${attempt.error ?? '查看步骤 trace'}`,
      attempt.success ? '已通过' : '未保存',
      attempt.success ? 'success' : 'failure',
    ))
  }
}

function renderGameState(adapter, current) {
  const root = $('#game-view')
  root.replaceChildren()
  const view = buildGameViewModel(adapter, current)
  root.dataset.kind = view.kind
  $('#state-title').textContent = view.title
  $('#state-kicker').textContent = view.kind === 'oni'
    ? 'COLONY STATE'
    : view.kind === 'mock' ? 'TEST GAME STATE' : 'AUTHORITATIVE STATE'
  updateSuggestions(view.prompts)

  const intro = document.createElement('p')
  intro.className = 'game-view-description'
  intro.textContent = view.description
  root.append(intro)

  if (view.kind === 'empty') {
    const empty = document.createElement('div')
    empty.className = 'game-view-empty'
    empty.innerHTML = '<span>◇</span><strong>等待 Adapter</strong><small>连接后会自动选择展示器</small>'
    root.append(empty)
    return
  }

  if (view.kind === 'mock' && view.map) root.append(createMockMap(view.map))
  if (view.metrics.length) root.append(createMetrics(view.metrics))
  for (const section of view.sections) root.append(createStateSection(section))
  root.append(createCapabilitySection(adapter?.capabilities ?? []))

  const details = document.createElement('details')
  details.className = 'raw-state'
  const summary = document.createElement('summary')
  summary.textContent = '查看标准 observation'
  const raw = document.createElement('pre')
  raw.textContent = safeStatePreview(view.rawState)
  details.append(summary, raw)
  root.append(details)
}

function createMockMap(map) {
  const root = document.createElement('div')
  root.className = 'mini-map'
  root.setAttribute('aria-label', 'Mock Game 地图')
  const grid = document.createElement('div')
  grid.className = 'grid-lines'
  const coin = marker('●', '金币', 'coin')
  coin.style.left = `${15 + map.coin.x * 27.5}%`
  coin.style.top = `${78 - map.coin.y * 24.5}%`
  coin.style.opacity = map.coin.collected ? '.12' : '1'
  const player = marker('◆', '玩家', 'player')
  player.style.left = `${15 + map.player.x * 27.5}%`
  player.style.top = `${78 - map.player.y * 24.5}%`
  root.append(grid, coin, player)
  return root
}

function marker(symbol, label, className) {
  const root = document.createElement('div')
  root.className = className
  const icon = document.createElement('span')
  icon.textContent = symbol
  const caption = document.createElement('small')
  caption.textContent = label
  root.append(icon, caption)
  return root
}

function createMetrics(metrics) {
  const root = document.createElement('div')
  root.className = 'stats'
  for (const metric of metrics.slice(0, 4)) {
    const card = document.createElement('div')
    const label = document.createElement('span')
    label.textContent = metric.label
    const value = document.createElement('strong')
    value.textContent = metric.value
    card.append(label, value)
    root.append(card)
  }
  return root
}

function createStateSection(section) {
  const root = document.createElement('section')
  root.className = 'state-section'
  const heading = document.createElement('h3')
  heading.textContent = section.title
  root.append(heading)
  if (section.text) {
    const text = document.createElement('p')
    text.textContent = section.text
    root.append(text)
  }
  if (section.items?.length) {
    const list = document.createElement('dl')
    for (const item of section.items) {
      const label = document.createElement('dt')
      label.textContent = item.label
      const value = document.createElement('dd')
      value.textContent = item.value
      list.append(label, value)
    }
    root.append(list)
  } else if (!section.text && section.empty) {
    const empty = document.createElement('p')
    empty.className = 'state-section-empty'
    empty.textContent = section.empty
    root.append(empty)
  }
  return root
}

function createCapabilitySection(capabilities) {
  const root = document.createElement('section')
  root.className = 'state-section capability-section'
  const heading = document.createElement('h3')
  heading.textContent = '当前能力'
  const list = document.createElement('div')
  list.className = 'state-capabilities'
  for (const capability of capabilities.slice(0, 12)) {
    const item = document.createElement('span')
    item.textContent = `${capability.kind === 'action' ? '动作' : '观察'} · ${capability.name}`
    list.append(item)
  }
  if (!capabilities.length) {
    const empty = document.createElement('small')
    empty.textContent = 'Adapter 尚未声明能力。'
    list.append(empty)
  }
  root.append(heading, list)
  return root
}

function updateSuggestions(prompts) {
  const buttons = [$('#suggestion-primary'), $('#suggestion-secondary')]
  buttons.forEach((button, index) => {
    const prompt = prompts?.[index]
    button.hidden = !prompt
    if (!prompt) return
    button.textContent = prompt.label
    button.dataset.prompt = prompt.text
  })
}

function renderTraces() {
  const root = $('#trace-list')
  root.replaceChildren()
  const matched = snapshot.traces.filter(trace => traceMatchesFilter(trace, traceFilter, traceSearch))
  const traces = matched.slice(-100).reverse()
  $('#metric-traces').textContent = traceFilter === 'all' && !traceSearch
    ? `最近 ${traces.length} 条`
    : `匹配 ${matched.length} 条`
  if (!traces.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '发起一次对话后，这里会出现可审计的运行轨迹。'
    root.append(empty)
    return
  }
  for (const trace of traces) {
    const row = document.createElement('div')
    row.className = 'trace-row'
    const time = document.createElement('time')
    time.textContent = new Date(trace.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
    const kind = document.createElement('span')
    kind.className = 'trace-kind'
    kind.textContent = traceLabel(trace.kind)
    const detail = document.createElement('code')
    detail.textContent = traceDetail(trace)
    const game = document.createElement('b')
    game.textContent = trace.gameId
    row.append(time, kind, detail, game)
    root.append(row)
  }
}

function traceLabel(kind) {
  const labels = {
    'dsh.turn.started': 'AI 回合开始',
    'dsh.turn.completed': 'AI 回合完成',
    'dsh.step.started': '模型步骤开始',
    'dsh.step.completed': '模型步骤完成',
    'dsh.tool.called': '工具调用',
    'dsh.tool.result': '工具结果',
    'action.executed': '游戏动作结果',
    'game.observed': '游戏状态观察',
    'adapter.connected': 'Adapter 已连接',
    'adapter.disconnected': 'Adapter 已断开',
    'adapter.reconnected': 'Adapter 已重连',
    'agent.event': 'Agent 公开事件',
    'game-agent.latency': '游戏 Agent 耗时',
    'voice.latency': '语音链路耗时',
    'voice.failed': '语音链路失败',
  }
  return labels[kind] ?? kind
}

function traceDetail(trace) {
  const detail = { ...trace.detail }
  // Defence in depth: legacy traces may still contain private model text.
  delete detail.analysis
  delete detail.reasoning
  if (detail.eventType === 'analysis') delete detail.text
  const chain = traceCorrelation(trace)
  if (trace.kind === 'dsh.tool.called') {
    return [chain, detail.tool ?? '未知工具', JSON.stringify(detail.arguments ?? {})].filter(Boolean).join(' · ')
  }
  if (trace.kind === 'dsh.tool.result') {
    const outcome = detail.ok ? '成功' : `失败 ${detail.errorCode ?? ''}`.trim()
    return [chain, outcome, detail.result].filter(Boolean).join(' · ')
  }
  if (trace.kind === 'agent.event' && detail.callId) {
    const event = detail.eventType === 'action-result'
      ? (detail.ok ? '动作回执成功' : `动作回执失败 ${detail.errorCode ?? ''}`.trim())
      : detail.eventType === 'action' ? 'Agent 请求动作' : String(detail.eventType ?? 'Agent 事件')
    return [chain, event, detail.capability, detail.revision === undefined ? '' : `revision ${detail.revision}`]
      .filter(Boolean)
      .join(' · ')
  }
  if (trace.kind === 'action.executed') {
    const outcome = detail.ok ? '成功' : `失败 ${detail.errorCode ?? ''}`.trim()
    return [
      chain || 'requestId —',
      detail.capability ?? '未知动作',
      outcome,
      `Core ${formatMeasuredMs(detail.coreValidationMs)}`,
      `Adapter ${formatMeasuredMs(detail.adapterRoundTripMs)}`,
      `Bridge ${formatMeasuredMs(detail.bridgeRoundTripMs)}`,
      `游戏 ${formatMeasuredMs(detail.gameExecutionMs)}`,
      `revision ${detail.revision ?? '—'}`,
    ].join(' · ')
  }
  if (trace.kind === 'game.observed') {
    const reason = detail.reason === 'post-action' ? '动作后刷新' : detail.reason === 'reconnect' ? '重连刷新' : detail.reason === 'initial' ? '首次连接' : '手动刷新'
    return `${chain || '独立观察'} · ${reason} · Adapter ${formatMeasuredMs(detail.adapterRoundTripMs)} · revision ${detail.revision ?? '—'}`
  }
  if (trace.kind === 'game-agent.latency') {
    return [
      chain,
      `${detail.provider ?? 'provider'}/${detail.model ?? 'model'}`,
      `选择 ${formatMeasuredMs(detail.modelSelectionMs)}`,
      `截图 ${formatMeasuredMs(detail.captureMs)}`,
      `附件 ${formatMeasuredMs(detail.attachmentMs)}`,
      `首字 ${formatMeasuredMs(detail.firstTextMs)}`,
      `Agent ${formatMeasuredMs(detail.agentWaitMs)}`,
      `总计 ${formatMeasuredMs(detail.totalMs)}`,
    ].filter(Boolean).join(' · ')
  }
  if (trace.kind === 'voice.latency') {
    return [
      chain,
      `ASR ${formatMeasuredMs(detail.asrMs)}`,
      `Agent ${formatMeasuredMs(detail.agentMs)}`,
      `TTS ${formatMeasuredMs(detail.ttsMs)}`,
      `总计 ${formatMeasuredMs(detail.totalMs)}`,
    ].filter(Boolean).join(' · ')
  }
  if (trace.kind === 'voice.failed') {
    return [chain, `阶段 ${detail.stage ?? 'unknown'}`, detail.timeout ? '超时' : detail.errorName ?? '失败', `已耗时 ${formatMeasuredMs(detail.elapsedMs)}`]
      .filter(Boolean)
      .join(' · ')
  }
  return JSON.stringify(detail)
}

function traceCorrelation(trace) {
  const detail = trace.detail ?? {}
  const parts = []
  if (trace.sessionId) parts.push(`Session ${trace.sessionId}`)
  if (detail.turn !== undefined) parts.push(`回合 ${detail.turn}`)
  if (detail.step !== undefined) parts.push(`步骤 ${detail.step}`)
  if (detail.callId) parts.push(`callId ${detail.callId}`)
  if (detail.requestId) parts.push(`requestId ${detail.requestId}`)
  if (detail.interactionId) parts.push(`interaction ${detail.interactionId}`)
  return parts.join(' → ')
}

function formatMeasuredMs(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? `${Math.round(numeric)}ms` : '未提供'
}

function setMeasuredMetric(selector, value) {
  $(selector).textContent = formatMeasuredMs(value)
}

function renderAdapters() {
  const root = $('#adapter-list')
  root.replaceChildren()
  if (!snapshot.adapters.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = `尚未发现游戏 Adapter。Harness 正在等待 ${snapshot.runtime?.adapterUrl ?? 'Adapter WebSocket'}。`
    root.append(empty)
    return
  }
  for (const adapter of snapshot.adapters) {
    const card = document.createElement('article')
    card.className = 'adapter-card'
    card.classList.toggle('selected', adapter.gameId === activeAdapter()?.gameId)
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-pressed', String(adapter.gameId === activeAdapter()?.gameId))
    const select = () => {
      selectedGameId = adapter.gameId
      render()
    }
    card.addEventListener('click', select)
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        select()
      }
    })
    const logo = document.createElement('div')
    logo.className = 'adapter-logo'
    logo.textContent = '⌘'
    const body = document.createElement('div')
    const title = document.createElement('h3')
    title.textContent = adapter.displayName
    const meta = document.createElement('p')
    meta.textContent = `${adapter.adapterId} · v${adapter.adapterVersion} · Protocol ${adapter.protocolVersion}`
    const caps = document.createElement('div')
    caps.className = 'caps'
    ;(adapter.capabilities ?? []).forEach((capability) => {
      const item = document.createElement('span')
      item.textContent = `${capability.kind} / ${capability.name}`
      caps.append(item)
    })
    body.append(title, meta, caps)
    const status = document.createElement('div')
    status.className = 'adapter-status'
    status.textContent = adapter.status === 'connected' ? '● 已连接' : '○ 已断开，等待重连'
    status.classList.toggle('offline', adapter.status !== 'connected')
    card.append(logo, body, status)
    root.append(card)
  }
}

function renderGamePacks() {
  const root = $('#game-pack-list')
  root.replaceChildren()
  $('#game-pack-count').textContent = `${gamePacks.length} 个`
  if (!gamePacks.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '尚未安装 Game Pack。开发者可以从 Adapter Starter 复制第一份模板。'
    root.append(empty)
    return
  }
  for (const pack of gamePacks) {
    const manifest = pack.manifest
    const liveAdapter = snapshot.adapters.find(adapter => adapter.adapterId === manifest.adapter.id)
    const card = document.createElement('article')
    card.className = 'game-pack-card'
    const body = document.createElement('div')
    const title = document.createElement('h3')
    title.textContent = manifest.displayName
    const description = document.createElement('p')
    description.textContent = `${manifest.id} · v${manifest.version} · ${manifest.adapter.entry}`
    const meta = document.createElement('div')
    meta.className = 'game-pack-meta'
    for (const value of [
      `Protocol ${manifest.adapter.protocolVersion}`,
      `${Object.keys(manifest.content ?? {}).length} 个内容入口`,
      `${(manifest.assets ?? []).length} 个资源`,
      `${(manifest.permissions ?? []).length} 项权限声明`,
    ]) {
      const item = document.createElement('span')
      item.textContent = value
      meta.append(item)
    }
    body.append(title, description, meta)
    const actions = document.createElement('div')
    actions.className = 'game-pack-actions'
    const health = document.createElement('span')
    health.className = 'game-pack-health'
    health.classList.toggle('waiting', !liveAdapter)
    health.textContent = liveAdapter ? '● Adapter 已连接' : '○ 已安装，等待 Adapter'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger-small'
    remove.textContent = '卸载 Pack'
    remove.addEventListener('click', async () => {
      const desktop = window.harnessDesktop?.platform
      if (!desktop?.uninstallGamePack) return
      remove.disabled = true
      try {
        const result = await desktop.uninstallGamePack(manifest.id, manifest.version)
        gamePacks = result.gamePacks ?? gamePacks
        renderGamePacks()
      } catch (error) {
        addMessage('assistant', `卸载 Game Pack 失败：${error.message}`)
      } finally {
        remove.disabled = false
      }
    })
    actions.append(health, remove)
    card.append(body, actions)
    root.append(card)
  }
}

async function refreshGamePacks() {
  const desktop = window.harnessDesktop?.platform
  gamePacks = desktop?.listGamePacks ? await desktop.listGamePacks() : []
}

function formatEvaluationModel(model) {
  return model?.provider && model?.model ? `${model.provider}/${model.model}` : '尚未读取'
}

function renderEvaluation() {
  const result = evaluationState.result
  $('#evaluation-model').textContent = formatEvaluationModel(result?.model ?? evaluationState.currentModel)
  $('#evaluation-status').textContent = evaluationState.running ? '运行中' : result ? (result.status === 'passed' ? '通过' : '未通过') : '尚未运行'
  $('#evaluation-score').textContent = result ? `${result.score}%` : '—'
  $('#evaluation-duration').textContent = result ? `${(result.durationMs / 1000).toFixed(1)}s` : '—'
  $('#evaluation-progress').textContent = evaluationState.progress
  $('#run-dst-butterfly-evaluation').disabled = evaluationState.running
  $('#run-dst-butterfly-evaluation').textContent = evaluationState.running ? '正在运行…' : '运行全部（1 项）'

  const scoreList = $('#evaluation-score-list')
  scoreList.replaceChildren()
  for (const score of result?.scores ?? []) scoreList.append(learningRow(
    score.name, score.detail || '无详细信息', score.passed ? 'PASS' : 'FAIL', score.passed ? 'success' : 'failure',
  ))
  if (!result?.scores?.length) scoreList.append(learningEmpty('运行后显示每项 PASS / FAIL。'))
  $('#evaluation-check-count').textContent = `${result?.scores?.length ?? 4} 项`
  $('#evaluation-result-path').textContent = result?.resultPath ?? '本地保存'

  const log = $('#evaluation-log')
  log.replaceChildren()
  if (!result) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '尚无测评记录。'
    log.append(empty)
    return
  }
  const replies = document.createElement('div')
  replies.className = 'evaluation-replies'
  for (const [title, text] of [['学习回复', result.firstReply], ['复跑回复', result.secondReply]]) {
    const card = document.createElement('article')
    card.className = 'evaluation-reply'
    const heading = document.createElement('strong')
    heading.textContent = title
    const body = document.createElement('pre')
    body.textContent = text || '（无公开文本）'
    card.append(heading, body)
    replies.append(card)
  }
  const atoms = document.createElement('div')
  atoms.className = 'evaluation-atoms'
  for (const call of result.atomCalls ?? []) {
    const row = document.createElement('article')
    row.className = 'learning-row success'
    const body = document.createElement('div')
    const heading = document.createElement('strong')
    heading.textContent = call.atom
    const detail = document.createElement('p')
    detail.textContent = `${JSON.stringify(call.arguments)} → ${call.error ?? JSON.stringify(call.result)}`
    const badge = document.createElement('span')
    badge.textContent = call.phase === 'learning' ? '学习试跑' : '已学复跑'
    body.append(heading, detail)
    row.append(body, badge)
    atoms.append(row)
  }
  log.append(replies, atoms)
}

async function refreshEvaluationCatalog() {
  const evaluation = window.harnessDesktop?.evaluation
  if (!evaluation?.catalog) return
  const catalog = await evaluation.catalog()
  evaluationState.catalog = catalog.evaluations ?? []
  evaluationState.currentModel = catalog.currentModel
  evaluationState.running = Boolean(catalog.running)
  renderEvaluation()
}

async function runDstButterflyEvaluation() {
  const evaluation = window.harnessDesktop?.evaluation
  if (!evaluation?.run || evaluationState.running) return
  evaluationState.running = true
  evaluationState.result = undefined
  evaluationState.progress = '正在准备隔离评测环境…'
  renderEvaluation()
  try {
    evaluationState.result = await evaluation.run('dst.learn-and-run-butterfly', event => {
      const tool = event?.event?.tool ? ` · ${event.event.tool}` : ''
      evaluationState.progress = `${event?.phase ?? '运行中'}${event?.detail ? ` · ${event.detail}` : ''}${tool}`
      renderEvaluation()
    })
    evaluationState.currentModel = evaluationState.result.model
    evaluationState.progress = evaluationState.result.status === 'passed'
      ? '全部评分项通过。'
      : '评测完成，请查看未通过的评分项和原子日志。'
  } catch (error) {
    evaluationState.progress = `评测失败：${error.message}`
  } finally {
    evaluationState.running = false
    renderEvaluation()
  }
}

function addMessage(role, text = '', work = undefined) {
  const message = document.createElement('article')
  message.className = `message ${role}`
  const avatar = document.createElement('div')
  avatar.className = 'avatar'
  avatar.textContent = role === 'user' ? 'YOU' : 'AI'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const label = document.createElement('span')
  label.className = 'role'
  label.textContent = role === 'user' ? '你' : '游戏伙伴'
  const content = document.createElement('p')
  content.textContent = text
  bubble.append(label, content)
  if (work?.workSessionId) {
    const details = document.createElement('div')
    details.className = 'work-session-details'
    const heading = document.createElement('strong')
    heading.textContent = work.title || '后台工作'
    const route = document.createElement('span')
    const executor = work.executor === 'codex-app-server' ? '工作 → Codex' : 'NPC 工作会话'
    route.textContent = `${executor} · ${work.status || '等待反馈'}`
    const session = document.createElement('code')
    session.textContent = `Session: ${work.workSessionId}`
    details.append(heading, route, session)
    if (work.codexThreadId) {
      const codex = document.createElement('code')
      codex.textContent = `Codex Thread: ${work.codexThreadId}`
      details.append(codex)
    }
    const open = document.createElement('button')
    open.type = 'button'
    open.textContent = '在内置 Harness 查看'
    open.addEventListener('click', () => { window.location.href = 'ai-native-game-harness://harness' })
    details.append(open)
    bubble.append(details)
  }
  message.append(avatar, bubble)
  $('#messages').append(message)
  $('#messages').scrollTop = $('#messages').scrollHeight
  return { message, bubble, content }
}

function appendRuntimeNotifications(fresh) {
  for (const notification of fresh?.runtime?.notifications ?? []) {
    if (!notification?.id || seenRuntimeNotifications.has(notification.id) || !notification.text) continue
    seenRuntimeNotifications.add(notification.id)
    addMessage('assistant', notification.text, notification)
  }
}

async function submitMessage(text) {
  if (busy || !text.trim()) return
  busy = true
  $('.send').disabled = true
  addMessage('user', text.trim())
  const assistant = addMessage('assistant')
  const thinking = document.createElement('div')
  thinking.className = 'thinking'
  thinking.textContent = 'AI Native Game Harness Session 正在运行（隐藏思维不展示）…'
  assistant.bubble.insertBefore(thinking, assistant.content)
  let streamedEvents = 0
  const handleEvent = (event) => {
    streamedEvents += 1
    if (event.type === 'action') thinking.textContent = `调用游戏动作 ${event.capability}…`
    if (event.type === 'action-result') thinking.textContent = event.result.ok
      ? `${event.capability} 已执行，状态 REV ${event.observation.revision}`
      : `${event.capability} 被拒绝：${event.result.error?.message ?? '未知错误'}`
    if (event.type === 'tool-call') thinking.textContent = `调用工具 ${event.tool}…`
    if (event.type === 'tool-result') thinking.textContent = event.ok
      ? `工具完成${Number.isFinite(event.durationMs) ? ` · ${event.durationMs}ms` : ''}`
      : `工具失败${event.errorCode ? ` · ${event.errorCode}` : ''}`
    if (event.type === 'text-delta') assistant.content.textContent += event.text
    if (event.type === 'done' && !assistant.content.textContent && event.text) assistant.content.textContent = event.text
    $('#messages').scrollTop = $('#messages').scrollHeight
  }
  try {
    const result = await api('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'desktop-demo', gameId: activeAdapter()?.gameId, message: text.trim() }),
    }, handleEvent)
    if (!result) throw new Error('当前页面没有连接 Platform Runtime。请从 Electron Desktop 启动。')
    if (!streamedEvents) result.events.forEach(handleEvent)
    thinking.remove()
    if (!assistant.content.textContent) assistant.content.textContent = 'AI Native Game Harness Session 已完成；本轮没有公开文本输出。'
    appendRuntimeNotifications(result.snapshot)
    snapshot = result.snapshot
    render()
  } catch (error) {
    thinking.remove()
    assistant.content.textContent = `请求失败：${error.message}`
  } finally {
    busy = false
    $('.send').disabled = false
    $('#message-input').focus()
  }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)))
$('#return-harness').addEventListener('click', () => {
  window.location.href = 'ai-native-game-harness://harness'
})
$('#run-dst-butterfly-evaluation').addEventListener('click', runDstButterflyEvaluation)
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => submitMessage(button.dataset.prompt)))
document.querySelectorAll('.learning-chat').forEach((button) => button.addEventListener('click', () => {
  setPage('chat')
  $('#message-input').value = button.dataset.learningPrompt ?? ''
  $('#message-input').focus()
}))
document.querySelectorAll('.story-chat').forEach((button) => button.addEventListener('click', () => {
  setPage('chat')
  $('#message-input').value = button.dataset.storyPrompt ?? ''
  $('#message-input').focus()
}))
$('.mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'))
$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('#message-input')
  const text = input.value
  input.value = ''
  submitMessage(text)
})
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    $('#chat-form').requestSubmit()
  }
})
$('#refresh-adapters').addEventListener('click', async () => {
  try {
    const [fresh] = await Promise.all([api('/api/snapshot'), refreshGamePacks()])
    if (fresh) snapshot = fresh
    render()
  } catch (error) {
    addMessage('assistant', `刷新失败：${error.message}`)
  }
})
$('#install-game-pack').addEventListener('click', async () => {
  const desktop = window.harnessDesktop?.platform
  if (!desktop?.installGamePack) {
    addMessage('assistant', 'Game Pack 安装只在 Electron Desktop 中提供。')
    return
  }
  const button = $('#install-game-pack')
  button.disabled = true
  try {
    const result = await desktop.installGamePack()
    gamePacks = result.gamePacks ?? gamePacks
    renderGamePacks()
  } catch (error) {
    addMessage('assistant', `安装 Game Pack 失败：${error.message}`)
  } finally {
    button.disabled = false
  }
})
$('#reset-game').addEventListener('click', async () => {
  try {
    const reset = await api('/api/reset', { method: 'POST' })
    snapshot = reset ?? structuredClone(fallback)
    render()
  } catch (error) {
    addMessage('assistant', `重置失败：${error.message}`)
  }
})
$('#trace-filter').addEventListener('change', (event) => {
  traceFilter = event.target.value
  renderTraces()
})
$('#trace-search').addEventListener('input', (event) => {
  traceSearch = event.target.value
  renderTraces()
})
$('#export-diagnostics').addEventListener('click', async () => {
  const status = $('#diagnostic-status')
  status.textContent = '正在生成脱敏诊断…'
  try {
    const desktop = window.harnessDesktop?.platform
    if (desktop?.exportDiagnostics) {
      const result = await desktop.exportDiagnostics()
      status.textContent = result.canceled ? '已取消导出。' : `已导出：${result.filePath}`
      return
    }
    const bundle = buildDiagnosticBundle(snapshot, { gamePacks })
    const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = diagnosticFilename()
    link.click()
    URL.revokeObjectURL(url)
    status.textContent = '已生成浏览器诊断文件。'
  } catch (error) {
    status.textContent = `导出失败：${error.message}`
  }
})

window.harnessDesktop?.platform?.onSnapshot((fresh) => {
  appendRuntimeNotifications(fresh)
  snapshot = fresh
  render()
})
const [initial] = await Promise.all([api('/api/snapshot'), refreshGamePacks(), refreshEvaluationCatalog()])
if (initial) {
  appendRuntimeNotifications(initial)
  snapshot = initial
}
render()
const initialPage = new URLSearchParams(location.search).get('page')
if (initialPage && pages[initialPage]) setPage(initialPage)
