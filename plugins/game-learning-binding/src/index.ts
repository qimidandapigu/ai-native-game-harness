import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GameCoreService } from '@ai-native-game-harness/game-core'
import type { AdapterSummary } from '@ai-native-game-harness/harness-core'
import type { JsonObject, JsonValue } from '@ai-native-game-harness/adapter-protocol'
import type {
  GameAtomExecutor,
  ProductLearningSnapshot,
  SkillProgram,
  XiaoTangYuanLearningService,
} from '@qimidandapigu/dsh-xiaotangyuan-game'

export const PRODUCT_LEARNING_PREFIX = 'AI_GAME_HARNESS_LEARNING '
export const PRODUCT_TURN_PREFIX = 'AI_GAME_HARNESS_PRODUCT_TURN_V1\n'

interface ProductTurn {
  turn: number
  playerText: string
  reply: string
}

interface LegacyAdapterHello {
  adapterId: string
  gameId: string
  version: string
  protocolVersion: string
  saveId?: string
  capabilities: string[]
  atoms: Array<{ name: string; description: string; parameters: string; returns: string }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gameCore: GameCoreService
    xiaotangyuanLearning: XiaoTangYuanLearningService
  }
}

function messageText(content: readonly { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('').trim()
}

function unwrapProductTurn(text: string): string | undefined {
  if (!text.startsWith(PRODUCT_TURN_PREFIX)) return undefined
  const separator = '\nPLAYER_MESSAGE:\n'
  const index = text.indexOf(separator, PRODUCT_TURN_PREFIX.length)
  return index < 0 ? undefined : text.slice(index + separator.length).trim()
}

function activeAdapter(core: GameCoreService): AdapterSummary | undefined {
  return core.harness.listAdapters().find(adapter => adapter.status === 'connected')
    ?? core.harness.listAdapters()[0]
}

function legacyAdapter(core: GameCoreService, adapter: AdapterSummary): LegacyAdapterHello {
  const observation = core.harness.snapshot().observations.find(item => item.gameId === adapter.gameId)
  const actions = adapter.capabilities.filter(capability => capability.kind === 'action')
  return {
    adapterId: adapter.adapterId,
    gameId: adapter.gameId,
    version: adapter.adapterVersion,
    protocolVersion: adapter.protocolVersion,
    ...(observation?.saveId === undefined ? {} : { saveId: observation.saveId }),
    capabilities: adapter.capabilities.map(capability => capability.name),
    atoms: actions.map(capability => ({
      name: capability.name,
      description: capability.description,
      parameters: JSON.stringify(capability.inputSchema ?? { type: 'object', additionalProperties: true }),
      returns: 'Adapter Protocol ActionResult; success requires ok=true.',
    })),
  }
}

function skillExecutor(ctx: Context, sessionId: string, gameId: string): GameAtomExecutor {
  return async (capability, args, signal) => {
    if (signal.aborted) throw signal.reason
    const feedback = await ctx.gameCore.harness.dispatchAgentAction({ sessionId, gameId }, {
      type: 'action',
      callId: randomUUID(),
      capability,
      arguments: args as Record<string, JsonValue>,
    })
    if (!feedback.result.ok) throw new Error(feedback.result.error?.message ?? `${capability} failed`)
    return {
      result: feedback.result.result ?? {},
      observation: feedback.observation as unknown as JsonObject,
    }
  }
}

class ProductLearningBinding {
  private readonly turns = new Map<string, ProductTurn>()
  private readonly memorySessions = new Set<string>()
  private readonly disposers: Array<() => void> = []
  private learningQueue: Promise<void> = Promise.resolve()
  private adapterSignature = ''

  constructor(private readonly ctx: Context) {}

  start(): void {
    this.disposers.push(this.registerMemoryRecallTool())
    this.disposers.push(this.registerSkillCatalogTool())
    this.disposers.push(this.registerSkillRunTool())
    this.disposers.push(this.registerSkillLearnTool())
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)))
    this.disposers.push(this.ctx.on('session/disposed', session => this.endSession(String(session.id))))
    this.disposers.push(this.ctx.gameCore.harness.subscribe(snapshot => {
      const signature = snapshot.adapters
        .map(adapter => `${adapter.gameId}:${adapter.adapterVersion}:${adapter.status}`)
        .sort()
        .join('|')
      if (signature === this.adapterSignature) return
      this.adapterSignature = signature
      this.publish()
    }))
    queueMicrotask(() => this.publish())
  }

  private adapterContext(): { adapter: AdapterSummary; legacy: LegacyAdapterHello } | undefined {
    const adapter = activeAdapter(this.ctx.gameCore)
    return adapter === undefined ? undefined : { adapter, legacy: legacyAdapter(this.ctx.gameCore, adapter) }
  }

  private publish(): void {
    const adapter = activeAdapter(this.ctx.gameCore)
    const snapshot: ProductLearningSnapshot = this.ctx.xiaotangyuanLearning.snapshot(adapter?.gameId)
    process.stdout.write(`${PRODUCT_LEARNING_PREFIX}${JSON.stringify(snapshot)}\n`)
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const sessionId = String(session.id)
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const playerText = unwrapProductTurn(messageText(event.data.content))
      if (playerText !== undefined) this.turns.set(sessionId, { turn: -1, playerText, reply: '' })
      return
    }
    const turn = this.turns.get(sessionId)
    if (turn === undefined) return
    if (event.type === 'turn/start') {
      turn.turn = event.data.turn
      return
    }
    if (event.type === 'assistant/message' && (turn.turn < 0 || event.data.turn === turn.turn)) {
      turn.turn = event.data.turn
      const reply = messageText(event.data.message.content)
      if (reply !== '') turn.reply = reply
      return
    }
    if (event.type !== 'turn/end' || event.data.turn !== turn.turn) return
    this.turns.delete(sessionId)
    if (event.data.reason.kind !== 'completed' || turn.reply === '') return
    this.learningQueue = this.learningQueue.then(async () => this.learnTurn(sessionId, turn)).catch(error => {
      this.ctx.logger.warn('ai-native-game-learning: background memory learning failed')
      this.ctx.logger.warn(error)
    })
  }

  private async learnTurn(sessionId: string, turn: ProductTurn): Promise<void> {
    const memory = this.ctx.xiaotangyuanLearning.memory
    const current = this.adapterContext()
    if (memory === undefined || current === undefined) return
    const observation = this.ctx.gameCore.harness.snapshot().observations.find(item => item.gameId === current.adapter.gameId)
    if (!this.memorySessions.has(sessionId)) {
      memory.adapterConnected(sessionId, current.legacy)
      this.memorySessions.add(sessionId)
    }
    const request = {
      text: turn.playerText,
      context: {
        ...(observation?.saveId === undefined ? {} : { saveId: observation.saveId }),
        ...(observation === undefined ? {} : { observation: observation as unknown as Record<string, unknown> }),
      },
    }
    memory.scheduleLearn(
      sessionId,
      current.legacy,
      request,
      turn.reply,
      `dsh:${sessionId}:${turn.turn}`,
      this.ctx.agentDefaultModel.currentSelection(),
    )
    await memory.flush()
    this.publish()
  }

  private endSession(sessionId: string): void {
    this.turns.delete(sessionId)
    if (!this.memorySessions.delete(sessionId)) return
    this.ctx.xiaotangyuanLearning.memory?.endSession(sessionId)
  }

  private registerMemoryRecallTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_learning_memory_recall',
      description: 'Recall durable player and current game-save memory before answering a Desktop game turn. Current authoritative game observation and tool results always override recalled memory.',
      parameters: {
        query: { type: 'string', required: true, description: 'The player message or the concrete topic to recall.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            available: { type: 'boolean', required: true },
            gameId: { type: 'string' },
            saveId: { type: 'string' },
            memory: { type: 'string' },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const memory = this.ctx.xiaotangyuanLearning.memory
        const current = this.adapterContext()
        const observation = current === undefined ? undefined : this.ctx.gameCore.harness.snapshot().observations.find(item => item.gameId === current.adapter.gameId)
        if (memory === undefined || current === undefined) {
          return { available: false, message: '当前没有可用的游戏记忆或已连接游戏。' }
        }
        const recalled = memory.recall(current.legacy, {
          text: args.query,
          context: {
            ...(observation?.saveId === undefined ? {} : { saveId: observation.saveId }),
            ...(observation === undefined ? {} : { observation: observation as unknown as Record<string, unknown> }),
          },
        })
        return recalled === undefined
          ? { available: false, gameId: current.adapter.gameId, saveId: observation?.saveId, message: '这个存档还没有相关长期记忆。' }
          : { available: true, gameId: current.adapter.gameId, saveId: observation?.saveId, memory: recalled, message: recalled }
      },
    }))
  }

  private registerSkillRunTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_learning_skill_run',
      description: 'Run a previously learned game skill. Learned skills are game-scoped and contain only Adapter action capabilities that passed a real execution trial.',
      parameters: {
        skillId: { type: 'string', required: true, description: 'Stable learned skill ID.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            skillId: { type: 'string', required: true },
            skillVersion: { type: 'number', required: true },
            traceJson: { type: 'string', required: true },
            message: { type: 'string', required: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args, exec) => {
        const skills = this.ctx.xiaotangyuanLearning.skills
        const current = this.adapterContext()
        if (skills === undefined || current === undefined) throw new Error('当前没有可用的技能库或已连接游戏。')
        const allowed = new Set(current.adapter.capabilities.filter(item => item.kind === 'action').map(item => item.name))
        const result = await skills.run(
          current.adapter.gameId,
          args.skillId,
          allowed,
          skillExecutor(this.ctx, String(exec.agent?.id ?? 'dsh-learning'), current.adapter.gameId),
          exec.signal,
        )
        this.publish()
        return {
          success: result.success,
          skillId: result.skillId,
          skillVersion: result.skillVersion,
          traceJson: JSON.stringify(result.trace),
          message: result.success ? '已学技能执行成功。' : `已学技能执行失败：${result.error}`,
          ...(result.error === undefined ? {} : { error: result.error }),
        }
      },
    }))
  }

  private registerSkillCatalogTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_learning_skill_catalog',
      description: 'Inspect the connected game action capabilities and the verified learned-skill IDs. Call this before proposing a skill program or when choosing a learned skill to run.',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            available: { type: 'boolean', required: true },
            gameId: { type: 'string' },
            catalogJson: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async () => {
        const current = this.adapterContext()
        const skills = this.ctx.xiaotangyuanLearning.skills
        if (current === undefined) return { available: false, catalogJson: '{}', message: '当前没有已连接游戏。' }
        const catalog = {
          gameId: current.adapter.gameId,
          actions: current.adapter.capabilities
            .filter(capability => capability.kind === 'action')
            .map(capability => ({
              name: capability.name,
              description: capability.description,
              inputSchema: capability.inputSchema ?? { type: 'object', additionalProperties: true },
            })),
          learnedSkills: (skills?.store.list(current.adapter.gameId) ?? []).map(skill => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            triggers: skill.triggers,
            version: skill.version,
          })),
        }
        const catalogJson = JSON.stringify(catalog)
        return { available: true, gameId: current.adapter.gameId, catalogJson, message: catalogJson }
      },
    }))
  }

  private registerSkillLearnTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_learning_skill_learn',
      description: 'Propose and immediately trial a xiaotangyuan-skill-v1 sequence composed only from the connected Adapter action capabilities. The skill is saved only when every real action step succeeds; failed attempts remain diagnostic history and never become runnable skills. Use at most three attempts for one player request.',
      parameters: {
        skillId: { type: 'string', required: true, description: 'Stable lowercase skill ID, e.g. oni.build-and-assign-bed.' },
        name: { type: 'string', required: true, description: 'Short skill name.' },
        description: { type: 'string', required: true, description: 'Goal completed by this skill.' },
        triggers: { type: 'string', required: true, description: 'Comma-separated player trigger phrases.' },
        programJson: { type: 'string', required: true, description: 'JSON with language xiaotangyuan-skill-v1 and 1-20 call steps. A later argument may reference $variable.field saved by an earlier step.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            success: { type: 'boolean', required: true },
            learned: { type: 'boolean', required: true },
            skillId: { type: 'string', required: true },
            version: { type: 'number', required: true },
            traceJson: { type: 'string', required: true },
            message: { type: 'string', required: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args, exec) => {
        const skills = this.ctx.xiaotangyuanLearning.skills
        const current = this.adapterContext()
        if (skills === undefined || current === undefined) throw new Error('当前没有可用的技能库或已连接游戏。')
        let program: SkillProgram
        try {
          program = JSON.parse(args.programJson) as SkillProgram
        } catch {
          throw new Error('技能程序不是有效 JSON。')
        }
        const allowed = new Set(current.adapter.capabilities.filter(item => item.kind === 'action').map(item => item.name))
        const attempt = await skills.tryLearn({
          gameId: current.adapter.gameId,
          skillId: args.skillId,
          name: args.name,
          description: args.description,
          triggers: args.triggers.split(/[,，]/).map(value => value.trim()).filter(Boolean),
          program,
        }, allowed, skillExecutor(this.ctx, String(exec.agent?.id ?? 'dsh-learning'), current.adapter.gameId), exec.signal)
        this.publish()
        const version = attempt.learned?.version ?? attempt.result.skillVersion
        return {
          success: attempt.result.success,
          learned: attempt.learned !== undefined,
          skillId: attempt.result.skillId,
          version,
          traceJson: JSON.stringify(attempt.result.trace),
          message: attempt.learned === undefined
            ? `本次真实试跑失败，候选技能未保存：${attempt.result.error}`
            : `真实试跑成功，已保存“${attempt.learned.name}”第 ${version} 版。`,
          ...(attempt.result.error === undefined ? {} : { error: attempt.result.error }),
        }
      },
    }))
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    for (const sessionId of [...this.memorySessions]) this.endSession(sessionId)
    await this.learningQueue
  }
}

export const name = 'ai-native-game-learning-binding'
export const inject = ['agentDefaultModel', 'gameCore', 'sessions', 'tools', 'xiaotangyuanLearning']

export function apply(ctx: Context): void {
  const binding = new ProductLearningBinding(ctx)
  ctx.effect(() => {
    binding.start()
    return async () => binding.close()
  })
}
