import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as gameCorePlugin from '@ai-native-game-harness/game-core'
import * as gameLearningPlugin from '@ai-native-game-harness/game-learning-binding'
import { MockGameAdapter } from '@ai-native-game-harness/mock-game/adapter'
import { SkillService, SkillStore } from '@qimidandapigu/dsh-xiaotangyuan-game'
import { describe, expect, it } from 'vitest'

describe('default DSH self-learning binding', () => {
  it('keeps failed skills out of the library and saves a fully successful real trial', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-game-learning-'))
    const ctx = new Context()
    const releaseSystemPrompt = ctx.provide('systemPrompt', { tools: () => undefined, section: () => undefined } as never)
    const releaseDefaultModel = ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
    const releaseSessions = ctx.provide('sessions', {} as never)
    const skills = new SkillService(new SkillStore({ enabled: true, directory, activeLimit: 10 }))
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
        skills: activeGameId === undefined ? [] : skills.store.list(activeGameId).map(({ program, ...skill }) => ({ ...skill, stepCount: program.steps.length })),
        skillAttempts: skills.store.listLearningAttempts(activeGameId).map(attempt => ({
          gameId: attempt.gameId,
          skillId: attempt.skillId,
          proposedVersion: attempt.proposedVersion,
          success: attempt.success,
          ...(attempt.error === undefined ? {} : { error: attempt.error }),
          createdAt: attempt.createdAt,
          stepCount: attempt.program.steps.length,
        })),
      }),
    }
    const releaseLearning = ctx.provide('xiaotangyuanLearning', learning as never)
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
        programJson: JSON.stringify({ language: 'xiaotangyuan-skill-v1', steps: [{ op: 'call', atom: 'game.collect' }] }),
      }, 'failed-trial')
      expect(failed).toMatchObject({ value: { success: false, learned: false } })
      expect(skills.store.list('mock-game')).toHaveLength(0)
      expect(skills.store.listLearningAttempts('mock-game')).toMatchObject([{ success: false }])

      const learned = await execute(ctx, 'game_learning_skill_learn', {
        skillId: 'mock.collect-coin',
        name: '走过去捡金币',
        description: '移动到金币位置并捡起金币',
        triggers: '捡金币,拿金币',
        programJson: JSON.stringify({
          language: 'xiaotangyuan-skill-v1',
          steps: [
            { op: 'call', atom: 'game.move', args: { x: 2, y: 1 } },
            { op: 'call', atom: 'game.collect' },
          ],
        }),
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
      await releaseSessions()
      await releaseDefaultModel()
      await releaseSystemPrompt()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function execute(ctx: Context, name: string, args: unknown, callId: string) {
  return await ctx.tools.execute({
    callId: CallId(callId),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}
