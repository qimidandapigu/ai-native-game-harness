import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from '../config.js'
import { detectDontStarve, installDontStarveMod } from '../installation/dont-starve-together.js'
import { detectStardew, installStardewMod } from '../installation/stardew-valley.js'
import type { FeedbackSubmitter } from '../runtime/feedback/contracts.js'

const detectionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean', required: true },
    platform: { type: 'string', required: true },
    gamePath: { type: 'string' },
    modsPath: { type: 'string' },
    smapiInstalled: { type: 'boolean', required: true },
    installedVersion: { type: 'string' },
    contentPatcherVersion: { type: 'string' },
    trinketTinkerVersion: { type: 'string' },
    companionPackVersion: { type: 'string' },
  },
} as const

export function registerGameTools(
  ctx: Context,
  feedback?: FeedbackSubmitter,
  dontStarveConfig?: ResolvedConfig['installers']['dontStarve'],
): void {
  ctx.tools.register(defineTool({
    name: 'game_mod_detect',
    description: 'Detect the local Stardew Valley installation, SMAPI, and the installed Stardew Agent Mod version. This is read-only and should be called before installation.',
    parameters: {
      gamePath: {
        type: 'string',
        description: 'Optional absolute Stardew Valley installation directory when automatic Steam detection fails.',
      },
    },
    output: {
      schema: detectionSchema,
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `Found Stardew Valley at ${value.gamePath}. SMAPI: ${value.smapiInstalled ? 'installed' : 'missing'}. Agent MOD: ${value.installedVersion ?? 'not installed'}. Content Patcher: ${value.contentPatcherVersion ?? 'missing'}. TrinketTinker: ${value.trinketTinkerVersion ?? 'missing'}. Companion pack: ${value.companionPackVersion ?? 'missing'}.`
          : 'Stardew Valley was not found automatically.',
      }],
    },
    execute: async (args, exec) => detectStardew(args.gamePath, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'dont_starve_mod_detect',
    description: '只读检测本机《饥荒联机版》、小汤圆 Lua Mod 和 Harness Adapter 启动器。用户提到检测、安装、更新或修复饥荒 Mod 时，必须先调用本工具，不要调用星露谷安装工具。',
    parameters: {
      gamePath: {
        type: 'string',
        description: '自动检测失败时，可提供《饥荒联机版》安装目录的绝对路径。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          platform: { type: 'string', required: true },
          gamePath: { type: 'string' },
          modsPath: { type: 'string' },
          modPath: { type: 'string' },
          installedVersion: { type: 'string' },
          launcherInstalled: { type: 'boolean', required: true },
          steamLaunchOption: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `已找到《饥荒联机版》：${value.gamePath}。小汤圆 Mod：${value.installedVersion ?? '未安装'}；Harness Adapter 启动器：${value.launcherInstalled ? '已安装' : '未安装'}。`
          : '没有自动找到《饥荒联机版》。',
      }],
    },
    execute: async (args, exec) => detectDontStarve(args.gamePath, exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'dont_starve_mod_install',
    description: '安装、更新或修复《饥荒联机版》的小汤圆 Lua Mod 与 DeepSeek Harness Adapter 启动器。会校验官方安装包、备份旧版本并在失败时回滚。工具只能返回需要玩家手动粘贴到 Steam 的启动项，不能自动修改 Steam 设置，禁止声称启动项已自动设置。只有用户明确要求安装、更新、恢复或修复饥荒 Mod 后才能调用；不要用于星露谷。',
    parameters: {
      confirmed: {
        type: 'boolean',
        required: true,
        description: '只有用户明确要求安装、更新、恢复或修复时才可设为 true。',
      },
      gamePath: {
        type: 'string',
        description: '自动检测失败时，可提供《饥荒联机版》安装目录的绝对路径。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true },
          gameId: { type: 'string', required: true },
          version: { type: 'string', required: true },
          gamePath: { type: 'string', required: true },
          modPath: { type: 'string', required: true },
          action: { type: 'string', required: true },
          backupPath: { type: 'string' },
          steamLaunchOption: { type: 'string', required: true },
          steamLaunchOptionApplied: { type: 'boolean', required: true },
          nextStep: { type: 'string', required: true },
          components: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `《饥荒联机版》小汤圆 Mod ${value.version} 已${value.action === 'kept' ? '是最新版本' : '安装'}到 ${value.modPath}。Steam 启动项尚未自动设置，请玩家手动粘贴：${value.steamLaunchOption}${value.backupPath === undefined ? '' : `。旧版本备份：${value.backupPath}`}`,
      }],
    },
    async execute(args, exec) {
      if (!args.confirmed) throw new Error('安装饥荒 Mod 需要用户明确确认')
      if (dontStarveConfig === undefined) throw new Error('饥荒安装器配置不可用')
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(180_000)])
      const result = await installDontStarveMod(args.gamePath, dontStarveConfig, signal)
      return {
        ...result,
        steamLaunchOptionApplied: false,
        nextStep: `请玩家在 Steam → 《饥荒联机版》→ 属性 → 启动选项中手动粘贴：${result.steamLaunchOption}`,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: '安装《饥荒联机版》小汤圆 Mod',
      kind: 'other',
      rawInput: args.gamePath ?? '自动检测 Steam 安装目录',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'game_mod_install',
    description: 'Download, verify, back up, and install or update the Stardew Agent Mod, its XiaoTangYuan companion pack, and required official framework components. Call only after the user explicitly asks to install or update it. SMAPI must already be installed.',
    parameters: {
      confirmed: {
        type: 'boolean',
        required: true,
        description: 'Must be true only when the user explicitly requested this installation or update.',
      },
      gamePath: {
        type: 'string',
        description: 'Optional absolute Stardew Valley installation directory when automatic Steam detection fails.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true },
          version: { type: 'string', required: true },
          gamePath: { type: 'string', required: true },
          modPath: { type: 'string', required: true },
          backupPath: { type: 'string' },
          components: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Installed Stardew Agent Mod ${value.version} at ${value.modPath}. Components: ${value.components}.${value.backupPath === undefined ? '' : ` Previous version backed up to ${value.backupPath}.`} Restart Stardew Valley through SMAPI to load it.`,
      }],
    },
    async execute(args, exec) {
      if (!args.confirmed) throw new Error('installation requires confirmed=true after an explicit user request')
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(120_000)])
      return installStardewMod(args.gamePath, signal)
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Install Stardew Agent Mod',
      kind: 'other',
      rawInput: args.gamePath ?? 'auto-detect Steam installation',
    }),
  }))

  if (feedback !== undefined) {
    ctx.tools.register(defineTool({
      name: 'game_feedback_submit',
      description: 'Submit a player-authored product feature request to the official XiaoTangYuan feedback service. Call this automatically when the player clearly wishes the Harness, companion, game Adapter, or Mod had a missing capability or behaved differently. Do not call for an ordinary in-game action request. Submit once per distinct suggestion and preserve the player quote exactly.',
      parameters: {
        title: {
          type: 'string',
          required: true,
          description: 'A concise Chinese title for the requested capability.',
        },
        summary: {
          type: 'string',
          required: true,
          description: 'A factual explanation of what capability the player wants and why it would help. Do not invent details.',
        },
        playerQuote: {
          type: 'string',
          required: true,
          description: 'The exact player sentence that expressed the suggestion.',
        },
        gameId: {
          type: 'string',
          required: true,
          description: 'The Game value shown in the current game context.',
        },
        adapterId: {
          type: 'string',
          required: true,
          description: 'The Adapter value shown in the current game context.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            reportId: { type: 'string', required: true },
            issueNumber: { type: 'number' },
            issueUrl: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `反馈已上传，编号 ${value.reportId}${value.issueNumber === undefined ? '' : `，Issue #${value.issueNumber}`}`,
        }],
      },
      execute: async (args, exec) => feedback.submit({
        category: 'feature_request',
        title: args.title,
        summary: args.summary,
        playerQuote: args.playerQuote,
        gameId: args.gameId,
        adapterId: args.adapterId,
      }, exec.signal),
      presentCall: args => ({
        card: 'generic',
        title: 'Submit XiaoTangYuan Feedback',
        kind: 'other',
        rawInput: args.title,
      }),
    }))
  }
}
