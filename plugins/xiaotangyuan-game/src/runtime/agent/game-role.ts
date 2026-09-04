import type { AdapterHello } from '../../protocol/game.js'

const STARDew_GAME_ID = 'stardew-valley'

export const STARDew_ROLE_INSTRUCTIONS = [
  '你是住在《星露谷物语》里的小汤圆，是玩家傲娇、调皮但可靠的同伴。',
  '使用简短自然中文，不使用 Markdown；可以根据当前结构化观察讨论农场、时间、体力、NPC 和成长状态。',
  '需要改变游戏时必须调用 game_stardew-valley_ 开头的标准游戏工具。工具返回 result.ok=true 才能说动作成功；ok=false 时要如实说明拒绝原因。',
  '播种时玩家必须手持种子；清障只能清玩家附近八格的天然障碍，不能承诺会破坏作物、设施、果树、茶树或装有树液采集器的树。',
  '起飞只允许室外主地图；飞行中先落地再做其他动作。钓鱼、战斗和回家救助是否解锁，以当前同伴成长状态及工具结果为准。',
  '玩家明确说浇水、播种、收割、催熟、清理或砍树、起飞、落地、钓鱼协助、打怪、送我回家时，优先调用对应工具，不要用角色化台词否认一个已声明且当前可执行的能力。',
].join('')

const COMMANDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['stardew.plant_seeds_all', ['播种', '播完', '种子播完', '把种子种', '种满', 'plant']],
  ['stardew.water_all', ['浇水', '浇田', '浇地', '灌溉', 'water']],
  ['stardew.harvest_all', ['收菜', '收作物', '收庄稼', '收割', '采收', '采摘', 'harvest']],
  ['stardew.speed_grow', ['催熟', '加速生长', '加速成熟', '快点长', '明天收获', '一夜成熟', 'grow']],
  ['stardew.clear_debris', ['砍树', '砍一下树', '砍掉树', '伐木', '清空场地', '清理场地', '清理杂物', 'clear debris', 'choptree']],
  ['stardew.flight_takeoff', ['帮我起飞', '起飞', '飞起来', '升空', 'takeoff', 'fly up']],
  ['stardew.flight_land', ['帮我落地', '落地', '降落', '回到地面', 'land']],
  ['stardew.fish_help', ['帮我钓', '钓鱼协助', '完美收杆', '下一杆', 'fish help']],
  ['stardew.mine_combat', ['帮我打怪', '清怪', '保护我', '矿洞帮忙', 'combat', 'monster help']],
  ['stardew.rescue_home', ['送我回家', '带我回家', '回家睡觉', '救我回家', '回床', 'rescue home']],
]

const NEGATED = [
  /(?:不要|不用|别|不许|别再|无需).{0,8}(?:播种|种子|浇|收|催|砍|伐木|清理|起飞|落地|钓|打怪|回家)/,
  /(?:don't|don t|do not|dont|no need to).{0,20}(?:plant|water|harvest|grow|clear|chop|takeoff|land|fish|combat|rescue)/,
]

const HISTORICAL = [
  /(?:刚刚?|刚才|已经|之前|上次|昨天|我刚).{0,8}(?:播|种|浇|收|催|砍|清理|起飞|落地|钓|打怪|回家)/,
  /(?:just|already|previously|yesterday).{0,20}(?:planted|watered|harvested|cleared|chopped|landed|fished)/,
]

function normalize(text: string): string {
  return text.toLowerCase().replace(/[，。！？、,.!?;；:："'“”‘’]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Deterministic routing hint for explicit player commands. It never executes an
 * action itself: the Agent still has to call the standard DSH Tool, which keeps
 * HarnessCore validation, ActionResult and post-action observation intact.
 */
export function classifyStardewCommands(text: string): string[] {
  const normalized = normalize(text)
  if (normalized === '' || NEGATED.some(pattern => pattern.test(normalized))
    || HISTORICAL.some(pattern => pattern.test(normalized))) return []

  return COMMANDS
    .filter(([, aliases]) => aliases.some(alias => normalized.includes(alias)))
    .map(([capability]) => capability)
}

export function roleInstructionsFor(adapter: AdapterHello | undefined): string | undefined {
  return adapter?.gameId === STARDew_GAME_ID ? STARDew_ROLE_INSTRUCTIONS : undefined
}

export function deterministicRoutingFor(adapter: AdapterHello | undefined, text: string): string | undefined {
  if (adapter?.gameId !== STARDew_GAME_ID) return undefined
  const capabilities = classifyStardewCommands(text)
  if (capabilities.length === 0) return undefined
  return [
    `确定性命令路由已匹配：${capabilities.join(', ')}。`,
    '这是玩家当前明确提出的动作请求。必须按顺序调用对应的标准游戏工具，并以每个工具的 ActionResult 为准；不要仅用文字假装执行。',
  ].join('')
}
