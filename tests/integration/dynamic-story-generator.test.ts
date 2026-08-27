import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as gameCorePlugin from '@ai-native-game-harness/game-core'
import * as storyPlugin from '@ai-native-game-harness/dsh-story-generator'
import { GamePackRegistry } from '@ai-native-game-harness/game-pack'
import { MockGameAdapter } from '@ai-native-game-harness/mock-game/adapter'
import { StoryStore } from '@ai-native-game-harness/story-runtime'
import { describe, expect, it } from 'vitest'

describe('dynamic StoryBeat generation on the default DSH Session', () => {
  it('loads narrative policy, rejects invented facts, and advances only from Adapter evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-game-story-'))
    const dataRoot = join(root, 'state')
    const packRoot = join(root, 'packs')
    const sourceRoot = join(root, 'source')
    await createMockPack(sourceRoot)
    await new GamePackRegistry(packRoot).install(sourceRoot)

    const ctx = new Context()
    const releaseSystemPrompt = ctx.provide('systemPrompt', { tools: () => undefined, section: () => undefined } as never)
    const toolsFiber = await ctx.plugin(ToolRuntime, { mode: 'native' })
    const coreFiber = await ctx.plugin(gameCorePlugin)
    await ctx.gameCore.harness.connectAdapter(new MockGameAdapter())
    const storyFiber = await ctx.plugin(storyPlugin, { dataRoot, gamePackRoot: packRoot, productSnapshotOutput: false })

    try {
      expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
        'game_story_context', 'game_story_propose', 'game_story_choose',
      ]))

      const context = await execute(ctx, 'game_story_context', {}, 'story-context')
      expect(context.value).toMatchObject({ available: true, needsGeneration: true })
      expect(JSON.parse(String((context.value as { contextJson: string }).contextJson))).toMatchObject({
        contract: 'StoryBeat-v1',
        narrativePolicy: { themes: ['陪伴', '探索'] },
        identity: { gameId: 'mock-game', saveId: 'demo-save' },
      })

      const invented = await execute(ctx, 'game_story_propose', {
        planJson: JSON.stringify({ beats: [beat('invented-door', 'castle.doorOpened')] }),
      }, 'story-invalid')
      expect(invented.value).toMatchObject({ accepted: false })
      expect(String((invented.value as { error: string }).error)).toContain('not present')

      const accepted = await execute(ctx, 'game_story_propose', {
        planJson: JSON.stringify({ beats: [beat('first-coin', 'coin.collected')] }),
      }, 'story-valid')
      expect(accepted.value).toMatchObject({ accepted: true })
      expect(JSON.parse(String((accepted.value as { stateJson: string }).stateJson))).toMatchObject({
        status: 'active', activeBeat: { id: 'first-coin' },
      })

      await ctx.gameCore.harness.executeAction('mock-game', 'game.move', { x: 2, y: 1 }, { sessionId: 'story-test' })
      await ctx.gameCore.harness.executeAction('mock-game', 'game.collect', {}, { sessionId: 'story-test' })
      await waitFor(async () => (await ctx.gameStory.runtime.state({ gameId: 'mock-game', saveId: 'demo-save' })).history.length === 1)

      const state = await ctx.gameStory.runtime.state({ gameId: 'mock-game', saveId: 'demo-save' })
      expect(state).toMatchObject({
        status: 'needs-generation',
        history: [{ beat: { id: 'first-coin' }, outcome: 'completed', evidence: { observationRevision: 2, actualValue: true } }],
      })
      expect((await new StoryStore(dataRoot).state({ gameId: 'mock-game', saveId: 'demo-save' }))).toMatchObject({
        revision: state.revision,
        history: [{ beat: { id: 'first-coin' }, outcome: 'completed' }],
      })
    } finally {
      await storyFiber.dispose()
      await coreFiber.dispose()
      await toolsFiber.dispose()
      await releaseSystemPrompt()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function beat(id: string, path: string) {
  return {
    schemaVersion: 1,
    id,
    title: '金币花园的第一步',
    premise: '伙伴注意到花园里有一枚尚未拾取的金币。',
    goal: '走到金币旁边并把它拾起来。',
    characterMotivation: '伙伴希望用一个真实可验证的小目标建立信任。',
    completion: { path, operator: 'eq', value: true },
    capabilityHints: ['game.move', 'game.collect'],
    nextDirections: ['根据拾取金币后的新状态继续生成。'],
  }
}

async function createMockPack(root: string): Promise<void> {
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(join(root, 'content'), { recursive: true })
  await writeFile(join(root, 'dist', 'client.js'), 'export {}\n', 'utf8')
  await writeFile(join(root, 'content', 'narrative.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dynamic-narrative-policy',
    world: '一座所有剧情事实都必须由 Mock Adapter 证明的金币花园。',
    themes: ['陪伴', '探索'],
    allowedGoals: ['拾取真实存在的金币'],
    forbiddenClaims: ['不能虚构城堡或开门状态'],
    pacing: '一次只生成一个短目标。',
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, 'game-pack.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: 'mock-story-pack',
    version: '0.1.0',
    displayName: 'Mock Dynamic Story',
    adapter: { id: 'mock-game.adapter', entry: 'dist/client.js', protocolVersion: '1.0' },
    content: { narrative: 'content/narrative.json' },
    assets: [],
    permissions: [],
  }, null, 2)}\n`, 'utf8')
}

async function execute(ctx: Context, name: string, args: unknown, callId: string) {
  return await ctx.tools.execute({
    callId: CallId(callId),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for story transition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
