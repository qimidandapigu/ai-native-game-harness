import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tools'
import { resolveConfig, type Config } from './config.js'
import { WorkOrchestratorService } from './work-orchestrator-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workOrchestrator: WorkOrchestratorService
  }
}

export const name = 'dsh-work-orchestrator'
export const provide = 'workOrchestrator'
export const inject = ['agents', 'llm', 'permissionPresets', 'sessions', 'sessionTitle', 'tools']

export function apply(ctx: Context, config: Config = {}): void {
  const service = new WorkOrchestratorService(ctx, resolveConfig(config))
  ctx.effect(() => async () => service.close())
}

export type { Config, ResolvedCodexConfig, ResolvedConfig, WorkExecutorKind } from './config.js'
export { resolveConfig } from './config.js'
export { CodexAppServerClient } from './codex-app-server-client.js'
export type { CodexAppServerOptions, CodexProgress, CodexWorkerClient } from './codex-app-server-client.js'
export {
  compactWorkNotification,
  LEGACY_WORK_RELAY_PREFIX,
  WORK_RELAY_META_PREFIX,
  WORK_RELAY_PREFIX,
  WorkOrchestratorService,
  linkedWorkIntentShortcut,
  obviousExternalWorkRequest,
  parseWorkIntent,
  postTurnWorkIntentShortcut,
  requestsImmediateExecution,
  requestsCodex,
} from './work-orchestrator-service.js'
export type {
  CompletedCompanionTurn,
  WorkCompanionProfile,
  WorkContextSnapshot,
  WorkIntent,
  WorkNotification,
  WorkOrchestratorDependencies,
} from './work-orchestrator-service.js'
