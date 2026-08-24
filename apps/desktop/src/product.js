const pages = {
  chat: { title: '与游戏一起思考' },
  analysis: { title: '看清每一步决策' },
  adapters: { title: '管理游戏连接' },
}

const fallback = {
  adapters: [],
  observations: [],
  traces: [],
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

async function api(path, options) {
  const platform = window.harnessDesktop?.platform
  if (platform) {
    if (path === '/api/snapshot') return await platform.snapshot()
    if (path === '/api/chat') return await platform.chat(JSON.parse(options?.body ?? '{}'))
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
  $('#metric-traces').textContent = snapshot.traces.length
  const canReset = connected && adapter.capabilities.some((capability) => capability.kind === 'action' && capability.name === 'game.reset')
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
    kind.textContent = trace.kind
    const detail = document.createElement('code')
    detail.textContent = JSON.stringify(trace.detail)
    const game = document.createElement('b')
    game.textContent = trace.gameId
    row.append(time, kind, detail, game)
    root.append(row)
  }
}

function renderAdapters() {
  const root = $('#adapter-list')
  root.replaceChildren()
  if (!snapshot.adapters.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '尚未发现游戏 Adapter。Harness 正在等待 ws://127.0.0.1:43145/adapter。'
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
  thinking.textContent = '正在观察游戏…'
  assistant.bubble.insertBefore(thinking, assistant.content)
  try {
    const result = await api('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'desktop-demo', message: text.trim() }),
    })
    if (!result) throw new Error('当前页面没有连接 Platform Runtime。请从 Electron Desktop 启动。')
    for (const event of result.events) {
      if (event.type === 'analysis') thinking.textContent = event.text
      if (event.type === 'action') thinking.textContent = `调用 ${event.capability}…`
      if (event.type === 'action-result') thinking.textContent = event.result.ok
        ? `${event.capability} 已执行，状态 REV ${event.observation.revision}`
        : `${event.capability} 被拒绝：${event.result.error?.message ?? '未知错误'}`
      if (event.type === 'text-delta') {
        assistant.content.textContent += event.text
        await new Promise((resolve) => setTimeout(resolve, 55))
      }
      if (event.type === 'done' && !assistant.content.textContent) assistant.content.textContent = event.text
    }
    thinking.remove()
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
