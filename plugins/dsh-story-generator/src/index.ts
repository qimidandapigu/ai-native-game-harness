import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GameObservation } from '@ai-native-game-harness/adapter-protocol'
import { GamePackRegistry } from '@ai-native-game-harness/game-pack'
import type { GameCoreService } from '@ai-native-game-harness/game-core'
import type { AdapterSummary, HarnessSnapshot } from '@ai-native-game-harness/harness-core'
import {
  parseNarrativePolicy,
  StoryRuntime,
  StoryStore,
  type NarrativePolicyV1,
  type StoryBeatV1,
  type StoryIdentity,
  type StoryProductSnapshot,
  type StoryProposalContext,
  type StoryState,
} from '@ai-native-game-harness/story-runtime'

export const PRODUCT_STORY_PREFIX = 'AI_GAME_HARNESS_STORY '

export interface Config {
  /** Per-save generated StoryBeat state. */
  dataRoot?: string
  /** Installed Game Pack registry containing narrative policies. */
  gamePackRoot?: string
  /** Emit machine-readable snapshots for the Desktop parent process. */
  productSnapshotOutput?: boolean
}

export interface StoryGenerationContext {
  available: boolean
  needsGeneration: boolean
  message: string
  contextJson: string
  identity?: StoryIdentity
  state?: StoryState
  observation?: GameObservation
  policy?: NarrativePolicyV1
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gameCore: GameCoreService
    gameStory: DshStoryGeneratorService
  }
}

function activeAdapter(core: GameCoreService): AdapterSummary | undefined {
  return core.harness.listAdapters().find(adapter => adapter.status === 'connected')
    ?? core.harness.listAdapters()[0]
}

function observationFor(core: GameCoreService, adapter: AdapterSummary): GameObservation | undefined {
  return core.harness.snapshot().observations.find(observation => observation.gameId === adapter.gameId)
}

function defaultPolicy(adapter: AdapterSummary): NarrativePolicyV1 {
  return {
    schemaVersion: 1,
    kind: 'dynamic-narrative-policy',
    world: `A dynamic story grounded only in authoritative observations from ${adapter.displayName}.`,
    themes: ['player agency', 'observable consequences'],
    allowedGoals: ['Goals whose completion can be proven by a current Adapter observation path.'],
    forbiddenClaims: ['Never claim that a game event happened without Adapter evidence.'],
    pacing: 'Generate only 1 to 3 near-term StoryBeat objects, then continue from fresh observations.',
  }
}

function proposalContext(adapter: AdapterSummary, observation: GameObservation): StoryProposalContext {
  return {
    identity: { gameId: observation.gameId, saveId: observation.saveId },
    observation,
    actionCapabilities: new Set(adapter.capabilities
      .filter(capability => capability.kind === 'action')
      .map(capability => capability.name)),
  }
}

function parsePlan(text: string): StoryBeatV1[] {
  const parsed = JSON.parse(text) as unknown
  if (Array.isArray(parsed)) return parsed as StoryBeatV1[]
  if (typeof parsed === 'object' && parsed !== null && 'beats' in parsed && Array.isArray(parsed.beats)) {
    return parsed.beats as StoryBeatV1[]
  }
  throw new Error('planJson must be a StoryBeat array or an object with a beats array')
}

export class DshStoryGeneratorService extends Service {
  readonly runtime: StoryRuntime
  readonly packs: GamePackRegistry
  private readonly disposers: Array<() => void> = []
  private observationSignature?: string
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, readonly config: Config = {}) {
    super(ctx, 'gameStory')
    this.runtime = new StoryRuntime(new StoryStore(resolve(config.dataRoot ?? '.ai-native-game-harness/story')))
    this.packs = new GamePackRegistry(resolve(config.gamePackRoot ?? '.ai-native-game-harness/game-packs'))
  }

  start(): void {
    this.disposers.push(this.registerContextTool())
    this.disposers.push(this.registerProposeTool())
    this.disposers.push(this.registerChoiceTool())
    this.disposers.push(this.ctx.gameCore.harness.subscribe(snapshot => this.scheduleObservations(snapshot)))
    queueMicrotask(() => this.scheduleObservations(this.ctx.gameCore.harness.snapshot()))
  }

  async context(): Promise<StoryGenerationContext> {
    const adapter = activeAdapter(this.ctx.gameCore)
    if (adapter === undefined) {
      return { available: false, needsGeneration: false, contextJson: '{}', message: '当前没有已连接游戏，不能生成剧情。' }
    }
    const observation = observationFor(this.ctx.gameCore, adapter)
    if (observation === undefined) {
      return { available: false, needsGeneration: false, contextJson: '{}', message: '当前游戏还没有权威 Observation。' }
    }
    const identity = { gameId: observation.gameId, saveId: observation.saveId }
    await this.runtime.observe(identity, observation)
    const state = await this.runtime.state(identity)
    const installed = (await this.packs.list()).find(pack => pack.manifest.adapter.id === adapter.adapterId)
    let policy = defaultPolicy(adapter)
    let packContent: { characters?: string; gameplay?: string } = {}
    if (installed !== undefined) {
      const content = await this.packs.loadContent(installed.manifest.id)
      if (content.narrative !== undefined) policy = parseNarrativePolicy(content.narrative)
      packContent = {
        ...(content.characters === undefined ? {} : { characters: content.characters.slice(0, 12_000) }),
        ...(content.gameplay === undefined ? {} : { gameplay: content.gameplay.slice(0, 12_000) }),
      }
    }
    const generationContext = {
      contract: 'StoryBeat-v1',
      authority: 'The model proposes narrative. Story Runtime validates it. Only Adapter Observation proves completion or failure.',
      identity,
      state,
      observation,
      narrativePolicy: policy,
      ...packContent,
      actions: adapter.capabilities.filter(capability => capability.kind === 'action').map(capability => ({
        name: capability.name,
        description: capability.description,
        inputSchema: capability.inputSchema ?? { type: 'object', additionalProperties: true },
      })),
      generationRules: [
        'Generate 1 to 3 near-term beats, not a complete fixed plot.',
        'Each completion and optional failure path is relative to observation.state and must exist now.',
        'The first completion condition must be false in the current observation.',
        'Use only listed Adapter action names in capabilityHints.',
        'Historical beats are immutable. Continue from active state, history, openThreads and explicit player choices.',
      ],
    }
    const contextJson = JSON.stringify(generationContext)
    return {
      available: true,
      needsGeneration: state.status === 'needs-generation',
      identity,
      state,
      observation,
      policy,
      contextJson,
      message: contextJson,
    }
  }

  async snapshot(): Promise<StoryProductSnapshot> {
    return await this.runtime.snapshot(activeAdapter(this.ctx.gameCore)?.gameId)
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    await this.queue
  }

  private scheduleObservations(snapshot: HarnessSnapshot): void {
    const signature = snapshot.observations
      .map(observation => `${observation.gameId}:${observation.saveId}:${observation.revision}`)
      .sort()
      .join('|')
    if (signature === this.observationSignature) return
    this.observationSignature = signature
    this.queue = this.queue.then(async () => {
      for (const observation of snapshot.observations) {
        await this.runtime.observe({ gameId: observation.gameId, saveId: observation.saveId }, observation)
      }
      await this.publish()
    }).catch(error => {
      this.ctx.logger.warn('ai-native-game-story: observation transition failed')
      this.ctx.logger.warn(error)
    })
  }

  private async publish(): Promise<void> {
    if (!this.config.productSnapshotOutput) return
    process.stdout.write(`${PRODUCT_STORY_PREFIX}${JSON.stringify(await this.snapshot())}\n`)
  }

  private registerContextTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_story_context',
      description: 'Read the current generated-story state, narrative policy, Adapter actions and authoritative game observation. Call once before continuing or generating story.',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            available: { type: 'boolean', required: true },
            needsGeneration: { type: 'boolean', required: true },
            contextJson: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async () => {
        const context = await this.context()
        return {
          available: context.available,
          needsGeneration: context.needsGeneration,
          contextJson: context.contextJson,
          message: context.message,
        }
      },
    }))
  }

  private registerProposeTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_story_propose',
      description: 'Submit 1 to 3 model-generated StoryBeat-v1 objects. Runtime validates observation paths, Adapter capabilities, rolling-plan size and existing history before accepting them.',
      parameters: {
        planJson: { type: 'string', required: true, description: 'JSON array of StoryBeat-v1 objects, or {"beats":[...]}. Generate this from game_story_context.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            stateJson: { type: 'string', required: true },
            message: { type: 'string', required: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const adapter = activeAdapter(this.ctx.gameCore)
        const observation = adapter === undefined ? undefined : observationFor(this.ctx.gameCore, adapter)
        if (adapter === undefined || observation === undefined) {
          return { accepted: false, stateJson: '{}', message: '没有已连接游戏或权威 Observation，剧情未保存。', error: 'STORY_CONTEXT_UNAVAILABLE' }
        }
        try {
          const state = await this.runtime.propose(parsePlan(args.planJson), proposalContext(adapter, observation))
          await this.publish()
          return { accepted: true, stateJson: JSON.stringify(state), message: `已接受动态剧情片段，当前目标：${state.activeBeat?.goal ?? '等待后续生成'}` }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.publish()
          return { accepted: false, stateJson: JSON.stringify(await this.runtime.state({ gameId: observation.gameId, saveId: observation.saveId })), message: `剧情提案未通过校验：${message}`, error: message }
        }
      },
    }))
  }

  private registerChoiceTool(): () => void {
    return this.ctx.tools.register(defineTool({
      name: 'game_story_choose',
      description: 'Record an explicit player choice from the current pendingChoices list. Never choose on behalf of the player.',
      parameters: {
        choiceId: { type: 'string', required: true, description: 'Choice id explicitly selected by the player.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            stateJson: { type: 'string', required: true },
            message: { type: 'string', required: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const context = await this.context()
        if (context.identity === undefined) return { accepted: false, stateJson: '{}', message: context.message, error: 'STORY_CONTEXT_UNAVAILABLE' }
        try {
          const state = await this.runtime.choose(context.identity, args.choiceId)
          await this.publish()
          return { accepted: true, stateJson: JSON.stringify(state), message: '玩家选择已记录，下一段剧情将从该方向动态生成。' }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { accepted: false, stateJson: JSON.stringify(await this.runtime.state(context.identity)), message: `选择未记录：${message}`, error: message }
        }
      },
    }))
  }
}

export const name = 'ai-native-game-story-generator'
export const provide = 'gameStory'
export const inject = ['gameCore', 'tools']

export function apply(ctx: Context, config: Config = {}): void {
  const service = new DshStoryGeneratorService(ctx, config)
  ctx.effect(() => {
    service.start()
    return async () => service.close()
  })
}
