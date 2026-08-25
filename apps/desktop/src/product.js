const pages = {
  chat: { title: '与游戏一起思考' },
  analysis: { title: '看清每一步决策' },
  adapters: { title: '管理游戏连接' },
}

const fallback = {
  adapters: [],
  observations: [],
  traces: [],
  runtime: {
    kind: 'standalone',
    label: 'Harness Core',
    status: 'starting',
    reconnectCount: 0,
    hiddenReasoning: 'not-exposed',
    directActions: true,
  },
}

const placeholderObservation = { gameId: '', revision: 0, state: { player: { x: 0, y: 0, energy: '—', coins: '—' }, coin: { x: 2, y: 1, collected: true } } }

let snapshot = structuredClone(fallback)
let busy = false
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
  return snapshot.adapters.find((item) => item.status === 'connected') ?? snapshot.adapters[0]
}

function render() {
  const adapter = activeAdapter()
  const current = observation()
  const runtime = snapshot.runtime ?? fallback.runtime
  const player = current.state?.player ?? placeholderObservation.state.player
  const coin = current.state?.coin ?? placeholderObservation.state.coin
  const connected = adapter?.status === 'connected'
  $('#game-name').textContent = adapter?.displayName ?? '等待游戏连接'
  $('#live-status').textContent = connected ? 'LIVE' : adapter ? 'OFFLINE' : 'WAIT'
  $('#revision-badge').textContent = adapter ? `REV ${current.revision}` : 'NO GAME'
  $('#stat-position').textContent = player.x === undefined || player.y === undefined ? '—' : `${player.x}, ${player.y}`
  $('#stat-energy').textContent = player.energy ?? '—'
  $('#stat-coins').textContent = player.coins ?? '—'
  const playerX = Number.isFinite(Number(player.x)) ? Number(player.x) : 0
  const playerY = Number.isFinite(Number(player.y)) ? Number(player.y) : 0
  $('#player-marker').style.left = `${15 + playerX * 27.5}%`
  $('#player-marker').style.top = `${78 - playerY * 24.5}%`
  $('#player-marker').style.opacity = adapter ? '1' : '.12'
  $('#coin-marker').style.opacity = adapter && !coin.collected ? '1' : '.12'
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
    ? `DSH 官方统计 · 平均首字 ${Math.round(ttftMs / ttftSteps)}ms`
    : 'DSH 官方统计 · 尚无首字'
  const latestAction = snapshot.traces.findLast?.(trace => trace.kind === 'action.executed')
    ?? [...snapshot.traces].reverse().find(trace => trace.kind === 'action.executed')
  setMeasuredMetric('#metric-core-action', latestAction?.detail?.coreValidationMs)
  setMeasuredMetric('#metric-adapter-action', latestAction?.detail?.adapterRoundTripMs)
  setMeasuredMetric('#metric-bridge-action', latestAction?.detail?.bridgeRoundTripMs)
  setMeasuredMetric('#metric-game-action', latestAction?.detail?.gameExecutionMs)
  $('#metric-traces').textContent = `最近 ${Math.min(snapshot.traces.length, 20)} 条`
  $('#runtime-name').textContent = `${runtime.label ?? 'Harness Runtime'} ${runtime.status === 'online' ? '在线' : '连接中'}`
  $('#runtime-meta').textContent = runtime.sessionId ? `Session ${runtime.sessionId}` : 'Protocol 1.0 · Local runtime'
  $('#runtime-agent').textContent = runtime.label ?? runtime.kind ?? 'Harness Runtime'
  $('#runtime-session').textContent = runtime.sessionId ?? 'Standalone Session'
  $('#runtime-status').textContent = runtime.agentRunning ? 'Agent 运行中' : runtime.status === 'online' ? '已连接' : '正在重连'
  $('#runtime-reconnects').textContent = runtime.reconnectCount ?? 0
  const canReset = runtime.directActions !== false && connected && adapter.capabilities.some((capability) => capability.kind === 'action' && capability.name === 'game.reset')
  $('#reset-game').disabled = !canReset
  $('#reset-game').textContent = adapter ? `重置 ${adapter.displayName}` : '重置游戏'
  renderTraces()
  renderAdapters()
}

function renderTraces() {
  const root = $('#trace-list')
  root.replaceChildren()
  const traces = snapshot.traces.slice(-20).reverse()
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
    'dsh.turn.started': 'DSH 回合开始',
    'dsh.turn.completed': 'DSH 回合完成',
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
  }
  return labels[kind] ?? kind
}

function traceDetail(trace) {
  const detail = { ...trace.detail }
  // Defence in depth: legacy traces may still contain private model text.
  delete detail.analysis
  delete detail.reasoning
  if (detail.eventType === 'analysis') delete detail.text
  if (trace.kind === 'action.executed') {
    const correlation = detail.requestId ? `requestId ${detail.requestId}` : 'requestId —'
    const outcome = detail.ok ? '成功' : `失败 ${detail.errorCode ?? ''}`.trim()
    return [
      correlation,
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
    const correlation = detail.requestId ? `requestId ${detail.requestId}` : '独立观察'
    const reason = detail.reason === 'post-action' ? '动作后刷新' : detail.reason === 'reconnect' ? '重连刷新' : detail.reason === 'initial' ? '首次连接' : '手动刷新'
    return `${correlation} · ${reason} · Adapter ${formatMeasuredMs(detail.adapterRoundTripMs)} · revision ${detail.revision ?? '—'}`
  }
  return JSON.stringify(detail)
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
    adapter.capabilities.forEach((capability) => {
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

function addMessage(role, text = '') {
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
  message.append(avatar, bubble)
  $('#messages').append(message)
  $('#messages').scrollTop = $('#messages').scrollHeight
  return { message, bubble, content }
}

async function submitMessage(text) {
  if (busy || !text.trim()) return
  busy = true
  $('.send').disabled = true
  addMessage('user', text.trim())
  const assistant = addMessage('assistant')
  const thinking = document.createElement('div')
  thinking.className = 'thinking'
  thinking.textContent = 'DSH Session 正在运行（隐藏思维不展示）…'
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
      body: JSON.stringify({ sessionId: 'desktop-demo', message: text.trim() }),
    }, handleEvent)
    if (!result) throw new Error('当前页面没有连接 Platform Runtime。请从 Electron Desktop 启动。')
    if (!streamedEvents) result.events.forEach(handleEvent)
    thinking.remove()
    if (!assistant.content.textContent) assistant.content.textContent = 'DSH Session 已完成；本轮没有公开文本输出。'
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
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => submitMessage(button.dataset.prompt)))
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
    const fresh = await api('/api/snapshot')
    if (fresh) snapshot = fresh
    render()
  } catch (error) {
    addMessage('assistant', `刷新失败：${error.message}`)
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

window.harnessDesktop?.platform?.onSnapshot((fresh) => {
  snapshot = fresh
  render()
})
const initial = await api('/api/snapshot')
if (initial) snapshot = initial
render()
