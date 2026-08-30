import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as gameCorePlugin from '@ai-native-game-harness/game-core'
import * as gameLearningPlugin from '@ai-native-game-harness/game-learning-binding'
import { MockGameAdapter } from '@ai-native-game-harness/mock-game/adapter'
import { SkillService, SkillStore, type SkillProgram, type SkillSourceStatement } from '@qimidandapigu/dsh-xiaotangyuan-game'
import { describe, expect, it, vi } from 'vitest'

describe('default DSH self-learning binding', () => {
  it('schedules completed Desktop product turns for the shared Worker service', async () => {
    const ctx = new Context()
    const scheduleTurn = vi.fn()
    const releaseSystemPrompt = ctx.provide('systemPrompt', { tools: () => undefined, section: () => undefined } as never)
    const releaseDefaultModel = ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
    } as never)
    const releaseSessions = ctx.provide('sessions', {} as never)
    const releaseWork = ctx.provide('workOrchestrator', { scheduleTurn } as never)
    const releaseLearning = ctx.provide('xiaotangyuanLearning', {
      memory: undefined,
      skills: undefined,
      snapshot: () => ({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        enabled: { memory: false, skills: false },
        memories: [],
        playStatistics: [],
        skills: [],
        skillAttempts: [],
      }),
    } as never)
    const toolsFiber = await ctx.plugin(ToolRuntime, { mode: 'native' })
    const coreFiber = await ctx.plugin(gameCorePlugin)
    const bindingFiber = await ctx.plugin(gameLearningPlugin)
    const session = { id: 'desktop-main-session' }
    const emitSessionEvent = (type: string, data: unknown) => {
      ctx.emit('session/event', session as never, { type, data } as never)
    }

    try {
      emitSessionEvent('user/message', {
        source: { kind: 'user' },
        content: [{
          type: 'text',
          text: `${gameLearningPlugin.PRODUCT_TURN_PREFIX}Desktop instructions\nPLAYER_MESSAGE:\n帮我做一份 HTML`,
        }],
      })
      emitSessionEvent('turn/start', { turn: 3 })
      emitSessionEvent('assistant/message', {
        turn: 3,
        message: { content: [{ type: 'text', text: '可以，我先确认需求并交给后台处理。' }] },
      })
      emitSessionEvent('turn/end', { turn: 3, reason: { kind: 'completed' } })

      await vi.waitFor(() => expect(scheduleTurn).toHaveBeenCalledTimes(1))
      expect(scheduleTurn).toHaveBeenCalledWith({
        companionSessionId: 'desktop-main-session',
        playerText: '帮我做一份 HTML',
        companionReply: '可以，我先确认需求并交给后台处理。',
        selection: { provider: 'test-provider', model: 'test-model' },
        source: 'desktop',
        companion: {
          id: 'xiaotangyuan',
          name: '小汤圆',
          workerInstructions: '玩家通过 AI Native Game Harness Desktop 交付工作；优先复用 DSH 已安装能力。',
          relayInstructions: '用简短自然的中文说明工作思路、进度或结果，并邀请玩家继续语音反馈。',
        },
      })

      emitSessionEvent('user/message', {
        source: { kind: 'plugin', plugin: 'dsh-work-orchestrator', form: 'relay' },
        content: [{ type: 'text', text: 'DSH_WORK_RELAY_V1\n后台更新' }],
      })
      emitSessionEvent('turn/start', { turn: 4 })
      emitSessionEvent('assistant/message', {
        turn: 4,
        message: { content: [{ type: 'text', text: 'Worker 已给出工作思路。' }] },
      })
      emitSessionEvent('turn/end', { turn: 4, reason: { kind: 'completed' } })
      await Promise.resolve()
      expect(scheduleTurn).toHaveBeenCalledTimes(1)
    } finally {
      await bindingFiber.dispose()
      await coreFiber.dispose()
      await toolsFiber.dispose()
      await releaseLearning()
      await releaseWork()
      await releaseSessions()
      await releaseDefaultModel()
      await releaseSystemPrompt()
    }
  })

  it('keeps failed skills out of the library and saves a fully successful real trial', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-game-learning-'))
    const ctx = new Context()
    const releaseSystemPrompt = ctx.provide('systemPrompt', { tools: () => undefined, section: () => undefined } as never)
    const releaseDefaultModel = ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
    const releaseSessions = ctx.provide('sessions', {} as never)
    const skills = new SkillService(new SkillStore({ enabled: true, directory, activeLimit: 5 }))
    const learning = {
      memory: undefined,
      skills,
      snapshot: (activeGameId?: string) => ({
        schemaVersion: 1 as const,
        updatedAt: new Date().toISOString(),
        enabled: { memory: false, skills: true },
        ...(activeGameId === undefined ? {} : { activeGameId }),
        memories: [],
        playStatistics: [],
        skills: activeGameId === undefined ? [] : skills.store.list(activeGameId).map(({ program, ...skill }) => ({ ...skill, stepCount: programStepCount(program) })),
        skillAttempts: skills.store.listLearningAttempts(activeGameId).map(attempt => ({
          gameId: attempt.gameId,
          skillId: attempt.skillId,
          proposedVersion: attempt.proposedVersion,
          success: attempt.success,
          ...(attempt.error === undefined ? {} : { error: attempt.error }),
          createdAt: attempt.createdAt,
          stepCount: programStepCount(attempt.program),
        })),
      }),
    }
    const releaseLearning = ctx.provide('xiaotangyuanLearning', learning as never)
    const releaseWork = ctx.provide('workOrchestrator', { scheduleTurn: () => undefined } as never)
    const toolsFiber = await ctx.plugin(ToolRuntime, { mode: 'native' })
    const coreFiber = await ctx.plugin(gameCorePlugin)
    await ctx.gameCore.harness.connectAdapter(new MockGameAdapter())
    const bindingFiber = await ctx.plugin(gameLearningPlugin)

    try {
      expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
        'game_learning_memory_recall',
        'game_learning_skill_catalog',
        'game_learning_skill_run',
        'game_learning_skill_learn',
      ]))

      const failed = await execute(ctx, 'game_learning_skill_learn', {
        skillId: 'mock.collect-coin',
        name: '捡金币',
        description: '捡起地图上的金币',
        triggers: '捡金币',
        sourceCode: 'await atom("game.collect", {});',
      }, 'failed-trial')
      expect(failed).toMatchObject({ value: { success: false, learned: false } })
      expect(skills.store.list('mock-game')).toHaveLength(0)
      expect(skills.store.listLearningAttempts('mock-game')).toMatchObject([{ success: false }])

      const learned = await execute(ctx, 'game_learning_skill_learn', {
        skillId: 'mock.collect-coin',
        name: '走过去捡金币',
        description: '移动到金币位置并捡起金币',
        triggers: '捡金币,拿金币',
        sourceCode: 'await atom("game.move", { x: 2, y: 1 });\nawait atom("game.collect", {});',
      }, 'successful-trial')
      expect(learned).toMatchObject({ value: { success: true, learned: true, version: 1 } })
      expect(skills.store.list('mock-game')).toMatchObject([{ id: 'mock.collect-coin', version: 1 }])

      await ctx.gameCore.harness.executeAction('mock-game', 'game.reset', {}, { sessionId: 'test-reset' })
      const rerun = await execute(ctx, 'game_learning_skill_run', { skillId: 'mock.collect-coin' }, 'rerun')
      expect(rerun).toMatchObject({ value: { success: true, skillVersion: 1 } })
    } finally {
      await bindingFiber.dispose()
      await coreFiber.dispose()
      await toolsFiber.dispose()
      await releaseLearning()
      await releaseWork()
      await releaseSessions()
      await releaseDefaultModel()
      await releaseSystemPrompt()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function programStepCount(program: SkillProgram): number {
  if (program.language === 'xiaotangyuan-skill-v1') return program.steps.length
  const countBlock = (statements: SkillSourceStatement[]): number => statements.reduce((total, statement) => {
    if (statement.kind === 'call') return total + 1
    if (statement.kind === 'if') return total + countBlock(statement.then) + countBlock(statement.else ?? [])
    if (statement.kind === 'repeat') return total + countBlock(statement.body)
    if (statement.kind === 'try') return total + countBlock(statement.body) + countBlock(statement.fallback)
    return total
  }, 0)
  return countBlock(program.body)
}

async function execute(ctx: Context, name: string, args: unknown, callId: string) {
  return await ctx.tools.execute({
    callId: CallId(callId),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}
