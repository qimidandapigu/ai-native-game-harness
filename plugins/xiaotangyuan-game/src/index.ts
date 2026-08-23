import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { resolveConfig, type Config } from './config.js'
import { GameGateway } from './gateway/game-gateway.js'
import { WindowsMediaHost } from './runtime/media/windows-media-host.js'
import { MultimodalRouter } from './runtime/multimodal/multimodal-router.js'
import { SignedFeedbackClient } from './runtime/feedback/signed-feedback-client.js'
import { CapabilityRegistry } from './runtime/capabilities.js'
import { SpeechController } from './runtime/speech/speech-controller.js'
import { VolcengineSpeechProvider } from './runtime/speech/volcengine-speech-provider.js'
import { registerGameTools } from './tools/game-mod-tools.js'
import { MemoryService } from './runtime/memory/memory-service.js'
import { registerMemoryTools } from './tools/memory-tools.js'
import { SkillStore } from './runtime/skills/skill-store.js'
import { SkillService } from './runtime/skills/skill-service.js'

export const name = 'dsh-xiaotangyuan-game'
export const inject = ['agentDefaultModel', 'agents', 'attachments', 'credentials', 'llm', 'sessions', 'tools']

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const feedback = resolved.feedback.enabled ? new SignedFeedbackClient(ctx, resolved.feedback) : undefined
  const memory = resolved.memory.enabled ? new MemoryService(ctx, resolved.memory) : undefined
  const skills = resolved.skills.enabled ? new SkillService(new SkillStore(resolved.skills)) : undefined
  registerGameTools(ctx, feedback, resolved.installers.dontStarve)
  if (memory !== undefined) registerMemoryTools(ctx, memory)

  ctx.effect(() => {
    const media = new WindowsMediaHost(ctx, resolved.media)
    const multimodal = new MultimodalRouter(ctx, resolved.vision, media)
    let speech: SpeechController | undefined
    const gateway = new GameGateway(
      ctx,
      resolved.host,
      resolved.port,
      multimodal,
      memory,
      skills,
      resolved.proactiveChat,
      processIds => speech?.updateTargets(processIds),
      feedback !== undefined,
      async (text, signal) => {
        if (speech === undefined) throw new Error('语音运行时尚未启动')
        await speech.speak(text, signal)
      },
      async (processId, interactionId, delta) => {
        await speech?.appendSpeechDelta(processId, interactionId, delta)
      },
      async (processId, interactionId, finalText) => {
        return await speech?.finishSpeechReply(processId, interactionId, finalText) ?? false
      },
      processId => media.startRecording(processId),
      processId => media.stopRecording(processId),
    )
    const capabilities = new CapabilityRegistry()
    const speechProvider = new VolcengineSpeechProvider(ctx, resolved.speech)
    capabilities.register('speech.transcribe', speechProvider)
    capabilities.register('speech.synthesize', speechProvider)
    speech = new SpeechController(ctx, resolved.speech, media, gateway, capabilities)
    void speech.start().catch(error => {
      ctx.logger.warn('xiaotangyuan-game: 语音运行时启动失败')
      ctx.logger.warn(error)
    })
    return async () => {
      await speech?.close()
      await gateway.close()
      await memory?.close()
    }
  })
}

export type { Config } from './config.js'
export type { FeedbackReceipt, FeedbackReport, FeedbackSubmission } from './runtime/feedback/contracts.js'
export type { AdapterHello, GameAtomDefinition, GameChatContext, GameChatRequest } from './protocol/game.js'
export type { RpcFailure, RpcRequest, RpcSuccess } from './protocol/json-rpc.js'
export { CapabilityRegistry, REQUIRED_ENGINE_CAPABILITIES, missingRequiredCapabilities } from './runtime/capabilities.js'
export { normalizeGameContext, renderGameContextForPrompt, AI_NATIVE_GAME_CONTEXT_SCHEMA } from './runtime/context/game-context.js'
export type { NormalizedGameContext } from './runtime/context/game-context.js'
export type { CapabilityProvider, CapabilityStatus, RequiredEngineCapability } from './runtime/capabilities.js'
export type {
  BinaryAsset,
  HostMediaService,
  MultimodalProvider,
  MultimodalRequest,
  SpeechRecognitionProvider,
  SpeechCapabilityProvider,
  SpeechSynthesisProvider,
  SpeechSynthesisRequest,
} from './runtime/providers/contracts.js'
