import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export interface Config {
  enabled?: boolean
  provider?: string
  model?: string
  reasoningEffort?: string
  directory?: string
  codex?: {
    executable?: string
    model?: string
    reasoningEffort?: string
    workingDirectory?: string
  }
}

export type WorkExecutorKind = 'dsh' | 'codex-app-server'

export interface ResolvedCodexConfig {
  executable: string
  model?: string
  reasoningEffort?: string
  workingDirectory: string
}

export interface ResolvedConfig {
  enabled: boolean
  selection?: ModelSelection
  directory: string
  legacyDirectories: string[]
  codex: ResolvedCodexConfig
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const provider = config.provider?.trim()
  const model = config.model?.trim()
  const reasoningEffort = config.reasoningEffort?.trim()
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('provider and model must be configured together')
  }
  if (reasoningEffort !== undefined && provider === undefined) {
    throw new Error('reasoningEffort requires provider and model')
  }
  const configuredDirectory = config.directory?.trim()
  if (configuredDirectory !== undefined && !isAbsolute(configuredDirectory)) {
    throw new Error('directory must be absolute')
  }
  const localDataRoot = process.env.LOCALAPPDATA?.trim() || join(homedir(), '.ai-native-game-harness')
  const directory = configuredDirectory ?? join(localDataRoot, 'AI Native Game Harness', 'work-orchestrator')
  const legacyDirectory = join(localDataRoot, 'XiaoTangYuan', 'profiles', 'default')
  const codexWorkingDirectory = config.codex?.workingDirectory?.trim() ?? join(directory, 'workspace')
  if (!isAbsolute(codexWorkingDirectory)) throw new Error('codex.workingDirectory must be absolute')
  const codexExecutable = config.codex?.executable?.trim() || 'codex'
  const codexModel = config.codex?.model?.trim()
  const codexReasoningEffort = config.codex?.reasoningEffort?.trim()
  return {
    enabled: config.enabled ?? true,
    ...(provider === undefined
      ? {}
      : {
          selection: {
            provider,
            model: model!,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
          },
        }),
    directory,
    legacyDirectories: directory === legacyDirectory ? [] : [legacyDirectory],
    codex: {
      executable: codexExecutable,
      ...(codexModel === undefined ? {} : { model: codexModel }),
      ...(codexReasoningEffort === undefined ? {} : { reasoningEffort: codexReasoningEffort }),
      workingDirectory: codexWorkingDirectory,
    },
  }
}
