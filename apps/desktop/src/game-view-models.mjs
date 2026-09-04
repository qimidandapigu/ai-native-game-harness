const renderers = new Map()

export function registerGameViewRenderer(gameId, renderer) {
  if (typeof gameId !== 'string' || !gameId.trim()) throw new Error('gameId is required')
  if (typeof renderer !== 'function') throw new Error('game view renderer must be a function')
  renderers.set(gameId, renderer)
  return () => {
    if (renderers.get(gameId) === renderer) renderers.delete(gameId)
  }
}

export function buildGameViewModel(adapter, observation) {
  if (!adapter) {
    return {
      kind: 'empty',
      title: '等待游戏连接',
      description: '任意符合 Adapter Protocol 1.0 的游戏连接后，状态会自动显示在这里。',
      metrics: [],
      sections: [],
      prompts: [
        { label: '查看连接', text: '现在连接了哪些游戏？' },
        { label: '了解能力', text: '当前有哪些游戏能力可以使用？' },
      ],
      rawState: {},
    }
  }
  const state = isObject(observation?.state) ? observation.state : {}
  const renderer = renderers.get(adapter.gameId) ?? genericRenderer
  const specific = renderer(adapter, observation ?? { gameId: adapter.gameId, revision: 0, state })
  return {
    gameId: adapter.gameId,
    title: adapter.displayName ?? adapter.gameId,
    description: '标准 Adapter observation',
    metrics: [],
    sections: [],
    prompts: [
      { label: '查看状态', text: '现在游戏是什么状态？' },
      { label: '建议下一步', text: '根据当前游戏状态，建议我下一步做什么？' },
    ],
    rawState: state,
    ...specific,
  }
}

export function safeStatePreview(value, options = {}) {
  const maxDepth = options.maxDepth ?? 5
  const maxArray = options.maxArray ?? 20
  const maxString = options.maxString ?? 200
  const maxCharacters = options.maxCharacters ?? 8_000
  const seen = new WeakSet()

  function visit(current, key, depth) {
    if (isSensitiveKey(key)) return '[已过滤]'
    if (typeof current === 'string') return current.length > maxString ? `${current.slice(0, maxString)}…` : current
    if (current === null || typeof current !== 'object') return current
    if (seen.has(current)) return '[循环引用]'
    if (depth >= maxDepth) return Array.isArray(current) ? `[${current.length} 项]` : '[对象]'
    seen.add(current)
    if (Array.isArray(current)) {
      const result = current.slice(0, maxArray).map((item) => visit(item, '', depth + 1))
      if (current.length > maxArray) result.push(`…其余 ${current.length - maxArray} 项`)
      return result
    }
    return Object.fromEntries(Object.entries(current).map(([childKey, child]) => [childKey, visit(child, childKey, depth + 1)]))
  }

  const text = JSON.stringify(visit(value, '', 0), null, 2) ?? '{}'
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters)}\n…状态预览已截断` : text
}

function genericRenderer(adapter, observation) {
  const state = isObject(observation.state) ? observation.state : {}
  const entries = Object.entries(state)
  const actionCount = adapter.capabilities?.filter((item) => item.kind === 'action').length ?? 0
  return {
    kind: 'generic',
    title: adapter.displayName ?? adapter.gameId,
    description: '该游戏没有专属视图，正在使用通用状态查看器。对话、能力和分析功能仍可正常使用。',
    metrics: [
      { label: '状态字段', value: entries.length },
      { label: '动作能力', value: actionCount },
      { label: '存档', value: observation.saveId ?? '—' },
    ],
    sections: [{
      title: '状态摘要',
      items: entries.slice(0, 12).map(([key, value]) => ({ label: key, value: compactValue(value) })),
      empty: 'Adapter 已连接，但尚未提供状态字段。',
    }],
  }
}

function mockRenderer(_adapter, observation) {
  const state = isObject(observation.state) ? observation.state : {}
  const player = isObject(state.player) ? state.player : {}
  const coin = isObject(state.coin) ? state.coin : {}
  return {
    kind: 'mock',
    title: 'Mock Game 测试场',
    description: '用于验证 Adapter、动作、状态回执和 Trace 的确定性测试游戏。',
    metrics: [
      { label: '位置', value: numberPair(player.x, player.y) },
      { label: '体力', value: player.energy ?? '—' },
      { label: '金币', value: player.coins ?? '—' },
    ],
    map: {
      player: { x: finiteNumber(player.x, 0), y: finiteNumber(player.y, 0) },
      coin: { x: finiteNumber(coin.x, 2), y: finiteNumber(coin.y, 1), collected: coin.collected === true },
    },
    prompts: [
      { label: '查看状态', text: '现在游戏是什么状态？' },
      { label: '去捡金币', text: '帮我去捡金币' },
    ],
  }
}

function oniRenderer(_adapter, observation) {
  const state = isObject(observation.state) ? observation.state : {}
  const entities = Array.isArray(state.entities)
    ? state.entities.filter(isObject)
    : Array.isArray(state.duplicants) ? state.duplicants.filter(isObject) : []
  const characters = entities.filter((item) => item.kind === undefined || item.kind === 'character')
  const oni = isObject(state.extensions) && isObject(state.extensions.oni) ? state.extensions.oni : {}
  const player = isObject(state.player) ? state.player : {}
  const cursor = isObject(state.ui) && isObject(state.ui.cursor)
    ? state.ui.cursor
    : isObject(state.cursor) ? state.cursor : {}
  const selectedId = oni.selectedDuplicantId ?? player.id
  const selected = characters.find((item) => String(item.id) === String(selectedId))
  const summary = typeof oni.summary === 'string' && oni.summary.trim() ? oni.summary.trim() : '等待《缺氧》Bridge 提供殖民地摘要。'
  return {
    kind: 'oni',
    title: '《缺氧》殖民地',
    description: '来自游戏 Bridge 的权威殖民地状态；动作仍由游戏规则最终裁决。',
    metrics: [
      { label: '复制人', value: characters.length },
      { label: '当前选择', value: selected?.name ?? (validSelection(selectedId) ? `#${selectedId}` : '—') },
      { label: '光标格', value: cursor.cell ?? '—' },
    ],
    sections: [
      { title: '殖民地摘要', text: summary },
      {
        title: '复制人',
        items: characters.slice(0, 12).map((item) => ({
          label: String(item.name ?? `复制人 #${item.id ?? '?'}`),
          value: `${item.selected ? '已选择 · ' : ''}${positionLabel(item.position)}${item.reachableFromCursor === false ? ' · 当前不可达' : ''}`,
        })),
        empty: '当前 observation 中没有复制人列表。',
      },
      {
        title: '光标',
        items: [
          { label: '单元格', value: cursor.cell ?? '—' },
          { label: '元素', value: cursor.element ?? '—' },
          { label: '是否为实体格', value: cursor.solid === true ? '是' : cursor.solid === false ? '否' : '—' },
        ],
      },
    ],
    prompts: [
      { label: '殖民地状态', text: '总结一下当前殖民地状态。' },
      { label: '建议下一步', text: '根据当前缺氧状态，建议我下一步做什么？' },
    ],
  }
}

function stardewRenderer(adapter, observation) {
  const state = isObject(observation.state) ? observation.state : {}
  const scene = isObject(state.scene) ? state.scene : {}
  const location = isObject(scene.location) ? scene.location : {}
  const clock = isObject(scene.clock) ? scene.clock : {}
  const weather = isObject(scene.weather) ? scene.weather : {}
  const player = isObject(state.player) ? state.player : {}
  const vitals = isObject(player.vitals) ? player.vitals : {}
  const health = isObject(vitals.health) ? vitals.health : {}
  const playerStamina = isObject(vitals.stamina) ? vitals.stamina : {}
  const companion = isObject(state.companion) ? state.companion : {}
  const growth = isObject(companion.growth) ? companion.growth : {}
  const companionStamina = isObject(companion.stamina) ? companion.stamina : {}
  const flight = isObject(companion.flight) ? companion.flight : {}
  const assists = isObject(companion.assists) ? companion.assists : {}
  const extensions = isObject(state.extensions) ? state.extensions : {}
  const stardew = isObject(extensions.stardew) ? extensions.stardew : {}
  const farm = isObject(stardew.farm) ? stardew.farm : {}
  const entities = Array.isArray(state.entities) ? state.entities.filter(isObject) : []
  const actions = adapter.capabilities?.filter((item) => item.kind === 'action').length ?? 0
  const growthForm = typeof growth.form === 'string' ? growth.form : 'seed'

  return {
    kind: 'stardew',
    title: '《星露谷物语》农场',
    description: '来自 SMAPI Adapter 的权威游戏状态；动作会经过 Harness Core、游戏门禁和主线程执行。',
    metrics: [
      { label: '地点', value: location.id ?? '未进入存档' },
      { label: '时间', value: stardewClock(clock) },
      { label: '小汤圆体力', value: valuePair(companionStamina.current, companionStamina.max) },
      { label: '动作能力', value: actions },
    ],
    sections: [
      {
        title: '农场状态',
        items: [
          { label: '天气', value: weather.kind ?? '—' },
          { label: '耕地', value: farm.tilled ?? 0 },
          { label: '待浇水', value: farm.dry ?? 0 },
          { label: '成熟作物', value: farm.ripe ?? 0 },
        ],
      },
      {
        title: '玩家状态',
        items: [
          { label: '生命', value: valuePair(health.current, health.max) },
          { label: '体力', value: valuePair(playerStamina.current, playerStamina.max) },
          { label: '金币', value: isObject(player.currency) ? player.currency.money ?? '—' : '—' },
          { label: '附近人物', value: entities.length },
        ],
      },
      {
        title: '小汤圆',
        items: [
          { label: '成长形态', value: growthLabel(growthForm) },
          { label: '战斗成长', value: valuePair(growth.combat, growth.threshold) },
          { label: '种植成长', value: valuePair(growth.farming, growth.threshold) },
          { label: '钓鱼成长', value: valuePair(growth.fishing, growth.threshold) },
          { label: '飞行', value: flight.airborne === true ? (flight.transitioning === true ? '过渡中' : '飞行中') : '地面' },
          { label: '战斗协助', value: assists.combatActive === true ? '运行中' : '未运行' },
        ],
      },
    ],
    prompts: [
      { label: '农场建议', text: '根据当前农场状态，建议我下一步做什么？' },
      { label: '浇水', text: '帮我把当前地图需要浇水的地都浇了' },
      { label: '收割', text: '帮我收割当前地图成熟的作物' },
      { label: '清理附近', text: '帮我清理周围八格的天然杂物' },
    ],
  }
}

function compactValue(value) {
  if (value === null) return '空'
  if (Array.isArray(value)) return `${value.length} 项`
  if (isObject(value)) {
    if (typeof value.name === 'string') return value.name
    if (value.current !== undefined && value.max !== undefined) return `${value.current} / ${value.max}`
    return `${Object.keys(value).length} 个字段`
  }
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value
  return String(value)
}

function positionLabel(value) {
  if (!isObject(value)) return '位置未知'
  if (value.cell !== undefined) return `格子 ${value.cell}`
  if (value.x !== undefined && value.y !== undefined) return `${value.x}, ${value.y}`
  return '位置未知'
}

function numberPair(left, right) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) ? `${left}, ${right}` : '—'
}

function valuePair(current, maximum) {
  return current !== undefined && maximum !== undefined ? `${current} / ${maximum}` : '—'
}

function stardewClock(clock) {
  if (clock.time === undefined) return '—'
  const text = String(clock.time).padStart(4, '0')
  return `${text.slice(0, -2)}:${text.slice(-2)}`
}

function growthLabel(form) {
  return ({ seed: '未定型', combat: '战斗型', farming: '种植型', fishing: '钓鱼型' })[form] ?? form
}

function finiteNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function validSelection(value) {
  return value !== undefined && value !== null && Number(value) >= 0
}

function isSensitiveKey(key) {
  return /token|secret|password|authorization|credential|api[_-]?key/i.test(key)
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

registerGameViewRenderer('mock-game', mockRenderer)
registerGameViewRenderer('oxygen-not-included', oniRenderer)
registerGameViewRenderer('stardew-valley', stardewRenderer)
