import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface VisionConfig {
  enabled?: boolean
  maxWidth?: number
}

export interface SpeechConfig {
  enabled?: boolean
  /** Compatibility shortcut that selects the same implementation for ASR and TTS. */
  provider?: string
  recognitionProvider?: string
  synthesisProvider?: string
  credentialRef?: string
  asrResourceId?: string
  asrFastResourceId?: string
  asrStreamingResourceId?: string
  ttsResourceId?: string
  ttsVoice?: string
}

export interface MediaConfig {
  enabled?: boolean
  pushToTalkVirtualKey?: number
  executablePath?: string
}

export interface FeedbackConfig {
  enabled?: boolean
  endpoint?: string
  clientId?: string
  credentialRef?: string
  timeoutMs?: number
}

export interface ProactiveChatConfig {
  enabled?: boolean
  intervalSeconds?: number
}

export interface MemoryConfig {
  enabled?: boolean
  autoLearn?: boolean
  directory?: string
  profileId?: string
  maxGameEntries?: number
}

export interface SkillConfig {
  enabled?: boolean
  directory?: string
  activeLimit?: number
}

export interface DontStarveInstallerConfig {
  manifestUrl?: string
  archivePath?: string
  archiveVersion?: string
  archiveSha256?: string
}

export interface InstallersConfig { dontStarve?: DontStarveInstallerConfig }

export interface Config {
  host?: string
  port?: number
  vision?: VisionConfig
  speech?: SpeechConfig
  media?: MediaConfig
  proactiveChat?: ProactiveChatConfig
  memory?: MemoryConfig
  skills?: SkillConfig
  feedback?: FeedbackConfig
  installers?: InstallersConfig
}

export interface ResolvedConfig {
  host: string
  port: number
  vision: {
    enabled: boolean
    maxWidth: number
  }
  speech: {
    enabled: boolean
    provider: string
    recognitionProvider: string
    synthesisProvider: string
    credentialRef: string
    asrResourceId: string
    asrFastResourceId: string
    asrStreamingResourceId: string
    ttsResourceId: string
    ttsVoice: string
  }
  media: {
    enabled: boolean
    pushToTalkVirtualKey: number
    executablePath?: string
  }
  feedback: {
    enabled: boolean
    endpoint?: string
    clientId: string
    credentialRef: string
    timeoutMs: number
  }
  proactiveChat: {
    enabled: boolean
    intervalSeconds: number
  }
  memory: {
    enabled: boolean
    autoLearn: boolean
    directory: string
    profileId: string
    maxGameEntries: number
  }
  skills: {
    enabled: boolean
    directory: string
    activeLimit: number
  }
  installers: {
    dontStarve: {
      manifestUrl: string
      archivePath?: string
      archiveVersion?: string
      archiveSha256?: string
    }
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 32145

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('dsh-xiaotangyuan-game only permits loopback hosts')
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('port must be an integer between 1024 and 65535')
  }

  const pushToTalkVirtualKey = config.media?.pushToTalkVirtualKey ?? 0x77
  if (!Number.isInteger(pushToTalkVirtualKey) || pushToTalkVirtualKey < 1 || pushToTalkVirtualKey > 255) {
    throw new Error('media.pushToTalkVirtualKey must be a Windows virtual-key code between 1 and 255')
  }
  const visionMaxWidth = config.vision?.maxWidth ?? 1280
  if (!Number.isInteger(visionMaxWidth) || visionMaxWidth < 320 || visionMaxWidth > 3840) {
    throw new Error('vision.maxWidth must be an integer between 320 and 3840')
  }
  const proactiveChatIntervalSeconds = config.proactiveChat?.intervalSeconds ?? 180
  if (!Number.isInteger(proactiveChatIntervalSeconds)
    || proactiveChatIntervalSeconds < 60
    || proactiveChatIntervalSeconds > 3600) {
    throw new Error('proactiveChat.intervalSeconds must be an integer between 60 and 3600')
  }

  const memoryProfileId = config.memory?.profileId?.trim() || 'default'
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(memoryProfileId)) {
    throw new Error('memory.profileId must contain 1-64 letters, digits, dots, underscores, or hyphens')
  }
  const configuredMemoryDirectory = config.memory?.directory?.trim()
  if (configuredMemoryDirectory !== undefined && !isAbsolute(configuredMemoryDirectory)) {
    throw new Error('memory.directory must be absolute')
  }
  const localDataRoot = process.env.LOCALAPPDATA?.trim() || join(homedir(), '.xiaotangyuan')
  const memoryDirectory = configuredMemoryDirectory
    ?? join(localDataRoot, 'XiaoTangYuan', 'profiles', memoryProfileId)
  const maxGameEntries = config.memory?.maxGameEntries ?? 300
  if (!Number.isInteger(maxGameEntries) || maxGameEntries < 50 || maxGameEntries > 2_000) {
    throw new Error('memory.maxGameEntries must be an integer between 50 and 2000')
  }
  const configuredSkillDirectory = config.skills?.directory?.trim()
  if (configuredSkillDirectory !== undefined && !isAbsolute(configuredSkillDirectory)) {
    throw new Error('skills.directory must be absolute')
  }
  const skillActiveLimit = config.skills?.activeLimit ?? 10
  if (!Number.isInteger(skillActiveLimit) || skillActiveLimit < 1 || skillActiveLimit > 50) {
    throw new Error('skills.activeLimit must be an integer between 1 and 50')
  }

  const feedbackEnabled = config.feedback?.enabled ?? false
  const feedbackEndpoint = config.feedback?.endpoint?.trim()
  if (feedbackEnabled && feedbackEndpoint === undefined) {
    throw new Error('feedback.endpoint is required when automatic feedback is enabled')
  }
  if (feedbackEndpoint !== undefined) {
    const url = new URL(feedbackEndpoint)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      throw new Error('feedback.endpoint must use HTTPS except for a loopback development receiver')
    }
  }
  const feedbackClientId = config.feedback?.clientId?.trim() ?? 'xiaotangyuan-official'
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(feedbackClientId)) {
    throw new Error('feedback.clientId must contain 3-80 letters, digits, dots, underscores, or hyphens')
  }
  const feedbackTimeoutMs = config.feedback?.timeoutMs ?? 15_000
  if (!Number.isInteger(feedbackTimeoutMs) || feedbackTimeoutMs < 1_000 || feedbackTimeoutMs > 60_000) {
    throw new Error('feedback.timeoutMs must be an integer between 1000 and 60000')
  }

  const dontStarveManifestUrl = config.installers?.dontStarve?.manifestUrl?.trim()
    ?? 'https://raw.githubusercontent.com/qimidandapigu/dsh-xiaotangyuan-game/main/distribution/dont-starve-together-v1.json'
  const manifest = new URL(dontStarveManifestUrl)
  if (manifest.protocol !== 'https:' && !(manifest.protocol === 'http:' && isLoopback(manifest.hostname))) {
    throw new Error('installers.dontStarve.manifestUrl must use HTTPS except for loopback development')
  }
  const archivePath = config.installers?.dontStarve?.archivePath?.trim()
  const archiveVersion = config.installers?.dontStarve?.archiveVersion?.trim()
  const archiveSha256 = config.installers?.dontStarve?.archiveSha256?.trim().toLowerCase()
  const localArchiveValues = [archivePath, archiveVersion, archiveSha256].filter(value => value !== undefined)
  if (localArchiveValues.length !== 0 && localArchiveValues.length !== 3) {
    throw new Error('local Don\'t Starve installer requires archivePath, archiveVersion, and archiveSha256 together')
  }
  if (archivePath !== undefined && !isAbsolute(archivePath)) {
    throw new Error('installers.dontStarve.archivePath must be absolute')
  }
  if (archiveVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(archiveVersion)) {
    throw new Error('installers.dontStarve.archiveVersion must be a stable semantic version')
  }
  if (archiveSha256 !== undefined && !/^[a-f0-9]{64}$/.test(archiveSha256)) {
    throw new Error('installers.dontStarve.archiveSha256 must be a SHA-256 digest')
  }

  return {
    host,
    port,
    vision: {
      enabled: config.vision?.enabled ?? true,
      maxWidth: visionMaxWidth,
    },
    speech: {
      enabled: config.speech?.enabled ?? true,
      provider: config.speech?.provider ?? 'auto',
      recognitionProvider: config.speech?.recognitionProvider ?? config.speech?.provider ?? 'auto',
      synthesisProvider: config.speech?.synthesisProvider ?? config.speech?.provider ?? 'auto',
      credentialRef: config.speech?.credentialRef ?? 'VOLCENGINE_API_KEY',
      asrResourceId: config.speech?.asrResourceId ?? 'volc.bigasr.auc',
      asrFastResourceId: config.speech?.asrFastResourceId ?? 'volc.bigasr.auc_turbo',
      asrStreamingResourceId: config.speech?.asrStreamingResourceId ?? 'volc.bigasr.sauc.duration',
      ttsResourceId: config.speech?.ttsResourceId ?? 'seed-tts-1.0',
      ttsVoice: config.speech?.ttsVoice ?? 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts',
    },
    media: {
      enabled: config.media?.enabled ?? true,
      pushToTalkVirtualKey,
      ...(config.media?.executablePath === undefined ? {} : { executablePath: config.media.executablePath }),
    },
    feedback: {
      enabled: feedbackEnabled,
      ...(feedbackEndpoint === undefined ? {} : { endpoint: feedbackEndpoint }),
      clientId: feedbackClientId,
      credentialRef: config.feedback?.credentialRef?.trim() || 'XIAOTANGYUAN_FEEDBACK_TOKEN',
      timeoutMs: feedbackTimeoutMs,
    },
    proactiveChat: {
      enabled: config.proactiveChat?.enabled ?? true,
      intervalSeconds: proactiveChatIntervalSeconds,
    },
    memory: {
      enabled: config.memory?.enabled ?? true,
      autoLearn: config.memory?.autoLearn ?? true,
      directory: memoryDirectory,
      profileId: memoryProfileId,
      maxGameEntries,
    },
    skills: {
      enabled: config.skills?.enabled ?? true,
      directory: configuredSkillDirectory ?? memoryDirectory,
      activeLimit: skillActiveLimit,
    },
    installers: {
      dontStarve: {
        manifestUrl: dontStarveManifestUrl,
        ...(archivePath === undefined
          ? {}
          : { archivePath, archiveVersion: archiveVersion!, archiveSha256: archiveSha256! }),
      },
    },
  }
}
