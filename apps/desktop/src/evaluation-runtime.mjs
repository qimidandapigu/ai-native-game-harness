import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ReconnectingAdapterClient } from '@ai-native-game-harness/adapter-websocket'
import { DshProductRuntime } from './dsh-product-runtime.mjs'

export const EVALUATION_CATALOG = Object.freeze([{
  id: 'dst.learn-and-run-butterfly',
  game: '饥荒联机版',
  name: '学习并复用抓蝴蝶技能',
  description: '当前 Harness Session 的实际模型从零生成受限技能，Fake DST 执行寻找、攻击、收集，再复用已保存技能。',
  checks: ['学习工具成功', '学习原子顺序', '已学技能复跑', '最终容器状态'],
}])

function exactSequence(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function toolNames(result) {
  return result.events.filter(event => event.type === 'tool-call').map(event => event.tool)
}

function publicReply(result) {
  return result.events.filter(event => event.type === 'text-delta').map(event => event.text).join('')
}

class FakeDstEvaluationAdapter {
  #gameId
  #revision = 0
  #sequence = 0
  #butterflies = new Map()
  #groundWings = []
  #listeners = new Set()
  #phase = 'learning'
  atomCalls = []
  butterflyWingsInContainer = 0

  constructor(gameId) { this.#gameId = gameId }
  setPhase(phase) { this.#phase = phase }

  spawnButterfly() {
    this.#sequence += 1
    const id = `butterfly-${this.#sequence}`
    this.#butterflies.set(id, { x: 2 + this.#sequence, z: 4 })
    this.#revision += 1
    this.#emit('butterfly.spawned', { targetId: id })
  }

  async hello() {
    return {
      protocolVersion: '1.0',
      adapterId: `ai-native-game-harness.eval.${this.#gameId}`,
      gameId: this.#gameId,
      displayName: '饥荒 Fake DST 自动测评',
      adapterVersion: '1.0.0',
      capabilities: [
        { name: 'game.observe', kind: 'observation', description: '读取 Fake DST 权威世界状态。' },
        {
          name: 'dst.find_nearest_butterfly', kind: 'action',
          description: '寻找最近的活蝴蝶。成功返回值位于 result.targetId、result.x、result.z。',
          inputSchema: { type: 'object', additionalProperties: false, properties: { radius: { type: 'number' } }, required: ['radius'] },
        },
        {
          name: 'dst.attack_butterfly', kind: 'action',
          description: '攻击指定蝴蝶并生成翅膀掉落。成功返回值位于 result.targetId、result.defeated、result.x、result.z。',
          inputSchema: { type: 'object', additionalProperties: false, properties: { targetId: { type: 'string' } }, required: ['targetId'] },
        },
        {
          name: 'dst.collect_butterfly_loot', kind: 'action',
          description: '拾取坐标附近的蝴蝶翅膀并放入小汤圆容器。成功返回值位于 result.count、result.items。',
          inputSchema: {
            type: 'object', additionalProperties: false,
            properties: { x: { type: 'number' }, z: { type: 'number' }, radius: { type: 'number' } },
            required: ['x', 'z', 'radius'],
          },
        },
      ],
    }
  }

  async observe() {
    return {
      gameId: this.#gameId, saveId: 'eval-save', revision: this.#revision,
      observedAt: new Date().toISOString(),
      state: {
        scene: { location: '森林空地' }, player: { name: 'Wilson', x: 0, z: 0 },
        companion: { name: '小汤圆', butterflyWingsInContainer: this.butterflyWingsInContainer },
        butterflies: [...this.#butterflies].map(([id, position]) => ({ id, ...position })),
        groundWings: this.#groundWings.map(position => ({ ...position })),
      },
    }
  }

  async execute(request) {
    if (request.gameId !== this.#gameId) return this.#failure(request, 'GAME_MISMATCH', '评测游戏不匹配')
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.#revision) {
      return this.#failure(request, 'REVISION_CONFLICT', 'Fake DST 状态已更新')
    }
    const call = { phase: this.#phase, atom: request.capability, arguments: structuredClone(request.arguments) }
    this.atomCalls.push(call)
    try {
      const result = this.#executeAtom(request.capability, request.arguments)
      call.result = structuredClone(result)
      return { requestId: request.requestId, ok: true, revision: this.#revision, result, timing: { bridgeRoundTripMs: 1, gameExecutionMs: 1 } }
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error)
      return this.#failure(request, 'DST_EVAL_FAILED', call.error)
    }
  }

  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  snapshot() { return { butterfliesRemaining: this.#butterflies.size, butterflyWingsInContainer: this.butterflyWingsInContainer } }

  #executeAtom(atom, args) {
    if (atom === 'dst.find_nearest_butterfly') {
      const entry = this.#butterflies.entries().next().value
      if (!entry) throw new Error('附近没有找到蝴蝶')
      return { targetId: entry[0], ...entry[1] }
    }
    if (atom === 'dst.attack_butterfly') {
      const position = this.#butterflies.get(args.targetId)
      if (!position) throw new Error('目标蝴蝶不存在或已经离开')
      this.#butterflies.delete(args.targetId)
      this.#groundWings.push(position)
      this.#revision += 1
      this.#emit('butterfly.defeated', { targetId: args.targetId })
      return { targetId: args.targetId, defeated: true, ...position }
    }
    if (atom === 'dst.collect_butterfly_loot') {
      if (this.#groundWings.length === 0) throw new Error('附近没有蝴蝶掉落')
      const count = this.#groundWings.length
      this.#groundWings = []
      this.butterflyWingsInContainer += count
      this.#revision += 1
      this.#emit('butterfly.loot-collected', { count })
      return { count, items: Array.from({ length: count }, () => 'butterflywings') }
    }
    throw new Error(`不支持的 Fake DST 原子：${atom}`)
  }

  #failure(request, code, message) { return { requestId: request.requestId, ok: false, revision: this.#revision, error: { code, message } } }
  #emit(type, payload) {
    const event = { eventId: randomUUID(), gameId: this.#gameId, revision: this.#revision, occurredAt: new Date().toISOString(), type, payload }
    for (const listener of this.#listeners) listener(event)
  }
}

function scoreResult({ firstTools, secondTools, learningAtoms, rerunAtoms, world }) {
  const expected = ['dst.find_nearest_butterfly', 'dst.attack_butterfly', 'dst.collect_butterfly_loot']
  const scores = [
    { id: 'learned', name: '模型生成并保存技能', passed: firstTools.includes('game_learning_skill_catalog') && firstTools.includes('game_learning_skill_learn'), detail: firstTools.join(' → ') },
    { id: 'learning-atoms', name: '学习试跑原子顺序', passed: exactSequence(learningAtoms, expected), detail: learningAtoms.join(' → ') },
    {
      id: 'rerun', name: '已学技能重复执行',
      passed: secondTools.includes('game_learning_skill_catalog') && secondTools.includes('game_learning_skill_run')
        && !secondTools.includes('game_learning_skill_learn') && exactSequence(rerunAtoms, expected),
      detail: `${secondTools.join(' → ')} | ${rerunAtoms.join(' → ')}`,
    },
    { id: 'world', name: '游戏世界最终结果', passed: world.butterfliesRemaining === 0 && world.butterflyWingsInContainer === 2, detail: `剩余蝴蝶 ${world.butterfliesRemaining}；容器翅膀 ${world.butterflyWingsInContainer}` },
  ]
  return { scores, score: Math.round(scores.filter(item => item.passed).length / scores.length * 100) }
}

export async function runDstButterflyProductEvaluation({ sourceRuntime, artifactRoot, onProgress = () => undefined }) {
  const sourceInfo = sourceRuntime.info()
  const selection = await sourceRuntime.modelSelection()
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const gameId = `dst-eval-${runId.toLowerCase()}`.slice(0, 80)
  const adapter = new FakeDstEvaluationAdapter(gameId)
  const client = new ReconnectingAdapterClient({ url: sourceInfo.adapterUrl, adapter, reconnectMinMs: 100, reconnectMaxMs: 500 })
  const evalRuntime = new DshProductRuntime({ baseUrl: sourceInfo.baseUrl, cwd: sourceInfo.cwd, adapterUrl: sourceInfo.adapterUrl, forceNewSession: true })
  const startedAt = Date.now()
  let phase = '准备中'
  const progress = (message, detail = '') => {
    phase = message
    onProgress({ phase: message, detail, elapsedMs: Date.now() - startedAt })
  }
  try {
    progress('正在连接 Fake DST', '创建隔离评测世界')
    client.start()
    await client.waitUntilConnected(10_000)
    adapter.spawnButterfly()

    progress('正在创建隔离 Session', `继承实际模型 ${selection.provider}/${selection.model}`)
    await evalRuntime.start()
    const actualSelection = await evalRuntime.selectModel(selection)

    progress('正在学习抓蝴蝶', '模型生成技能源码并真实试跑')
    const first = await evalRuntime.chat({
      gameId, evaluation: true,
      message: '请从零学习抓蝴蝶技能。先调用 game_learning_skill_catalog 查看当前 Fake DST 能力，再调用 game_learning_skill_learn，技能 ID 必须是 dst.hunt-and-collect-butterfly。技能要找到附近蝴蝶、击杀，并把掉落装进小汤圆容器。必须根据工具目录自己生成 xiaotangyuan-skill-v2 源码并真实试跑，不能只描述。',
    }, event => onProgress({ phase: '正在学习抓蝴蝶', event, elapsedMs: Date.now() - startedAt }))

    adapter.setPhase('rerun')
    adapter.spawnButterfly()
    progress('正在复跑已学技能', '验证技能已保存且可重复执行')
    const second = await evalRuntime.chat({
      gameId, evaluation: true,
      message: '请先调用 game_learning_skill_catalog，然后使用 game_learning_skill_run 执行刚才保存的 dst.hunt-and-collect-butterfly，再抓一只蝴蝶并收好掉落。不要重新学习，不能只描述。',
    }, event => onProgress({ phase: '正在复跑已学技能', event, elapsedMs: Date.now() - startedAt }))

    const firstTools = toolNames(first)
    const secondTools = toolNames(second)
    const learningCalls = adapter.atomCalls.filter(call => call.phase === 'learning')
    const rerunCalls = adapter.atomCalls.filter(call => call.phase === 'rerun')
    const world = adapter.snapshot()
    const scoring = scoreResult({ firstTools, secondTools, learningAtoms: learningCalls.map(call => call.atom), rerunAtoms: rerunCalls.map(call => call.atom), world })
    const result = {
      schemaVersion: 1, id: runId, evaluationId: 'dst.learn-and-run-butterfly',
      status: scoring.score === 100 ? 'passed' : 'failed', score: scoring.score,
      model: actualSelection, durationMs: Date.now() - startedAt,
      firstReply: publicReply(first), secondReply: publicReply(second),
      firstTools, secondTools, atomCalls: adapter.atomCalls, world, scores: scoring.scores,
      createdAt: new Date().toISOString(),
    }
    const directory = join(artifactRoot, runId)
    await mkdir(directory, { recursive: true })
    const resultPath = join(directory, 'result.json')
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await writeFile(join(artifactRoot, 'latest.json'), `${JSON.stringify({ ...result, resultPath }, null, 2)}\n`, 'utf8')
    progress('评测完成', `${result.score} 分`)
    return { ...result, resultPath }
  } catch (error) {
    const directory = join(artifactRoot, runId)
    await mkdir(directory, { recursive: true })
    const errorMessage = error instanceof Error ? error.message : String(error)
    await writeFile(join(directory, 'error.json'), `${JSON.stringify({ phase, error: errorMessage, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    throw error
  } finally {
    await evalRuntime.close().catch(() => undefined)
    await client.stop().catch(() => undefined)
  }
}
