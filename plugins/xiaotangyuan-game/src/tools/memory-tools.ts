import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EditableSharedField, MemoryIdentity } from '../runtime/memory/contracts.js'
import type { MemoryService } from '../runtime/memory/memory-service.js'

const EDITABLE_FIELDS = ['preferredName', 'language', 'responseStyle', 'interests', 'playStyles', 'companionName', 'companionTraits'] as const

function identity(memory: MemoryService, gameId?: string, saveId?: string): MemoryIdentity | undefined {
  if (gameId !== undefined && saveId !== undefined) return { gameId, saveId }
  const active = memory.activeIdentities()
  return active.length === 1 ? active[0] : undefined
}

function formatDuration(activeMs: number): string {
  const minutes = Math.round(activeMs / 60_000)
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

export function registerMemoryTools(ctx: Context, memory: MemoryService): void {
  ctx.tools.register(defineTool({
    name: 'xiaotangyuan_memory_view',
    description: '查看小汤圆独立的共同记忆、各游戏/存档记忆和本地游玩统计。玩家问“你记得我什么”“玩过哪些游戏”“这个存档记了什么”时调用。只读。若只查看当前存档可省略 gameId/saveId。',
    parameters: {
      gameId: { type: 'string', description: '可选，精确游戏 ID。与 saveId 一起提供时只查看该存档。' },
      saveId: { type: 'string', description: '可选，不透明存档 ID。与 gameId 一起提供时只查看该存档。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { report: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute: async (args) => {
      const selected = identity(memory, args.gameId, args.saveId)
      const profile = memory.store.getSharedProfile()
      const stats = memory.store.listPlayStatistics()
      const gameStats = memory.store.listGamePlayStatistics()
      const events = selected === undefined
        ? memory.store.listAllGameMemory(100)
        : memory.store.listGameMemory(selected, 100).filter(event => event.status === 'active')
      const report = [
        `共同记忆：${JSON.stringify(profile)}`,
        `游戏汇总：${gameStats.length === 0 ? '暂无' : gameStats.map(item => `${item.gameId}：${item.playDays} 天，${item.saveCount} 个存档，${item.sessionCount} 次，约 ${formatDuration(item.activeMs)}`).join('\n')}`,
        `游玩统计：${stats.length === 0 ? '暂无' : stats.map(item => `${item.gameId}/${item.saveId}：${item.playDays} 天，${item.sessionCount} 次，约 ${formatDuration(item.activeMs)}，${item.memoryCount} 条记忆`).join('\n')}`,
        `游戏记忆：${events.length === 0 ? '暂无' : events.map(item => `${item.id} | ${item.gameId}/${item.saveId} | ${item.kind} | ${item.summary}`).join('\n')}`,
      ].join('\n\n')
      return { report }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xiaotangyuan_memory_correct_shared',
    description: '根据玩家明确要求纠正或清除一项小汤圆共同记忆。不能根据模型推断调用。列表字段 interests、playStyles、companionTraits 使用逗号分隔，并会整体替换旧值。',
    parameters: {
      field: { type: 'string', required: true, description: `只能是：${EDITABLE_FIELDS.join(', ')}` },
      value: { type: 'string', description: '新值；列表字段用逗号分隔。clear=true 时省略。' },
      clear: { type: 'boolean', required: true, description: '玩家明确要求清除此字段时为 true，否则为 false。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { success: { type: 'boolean', required: true }, message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: async (args) => {
      if (!EDITABLE_FIELDS.includes(args.field as EditableSharedField)) throw new Error('不支持的共同记忆字段')
      const field = args.field as EditableSharedField
      const isList = field === 'interests' || field === 'playStyles' || field === 'companionTraits'
      const value = args.clear ? undefined : isList
        ? (args.value ?? '').split(/[,，]/).map(item => item.trim()).filter(Boolean)
        : args.value
      if (!args.clear && (value === undefined || (Array.isArray(value) ? value.length === 0 : value.trim() === ''))) throw new Error('纠正记忆需要提供新值')
      memory.store.replaceSharedField(field, value)
      return { success: true, message: `已${args.clear ? '清除' : '更新'}共同记忆字段 ${field}。` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'xiaotangyuan_memory_forget',
    description: '删除小汤圆记忆。仅在玩家明确要求忘记、删除或清空并确认范围后调用。单条记忆用 memoryId；当前存档可省略 gameId/saveId；scope=all 会清空共同记忆和全部游戏记忆，但默认保留游玩统计。',
    parameters: {
      scope: { type: 'string', required: true, description: 'event、current-save、shared 或 all。' },
      confirmed: { type: 'boolean', required: true, description: '只有玩家明确要求删除对应内容时才能为 true。' },
      memoryId: { type: 'string', description: 'scope=event 时必填，来自查看工具。' },
      gameId: { type: 'string', description: 'scope=current-save 时可选；当前只有一个游戏连接时可省略。' },
      saveId: { type: 'string', description: 'scope=current-save 时可选；当前只有一个游戏连接时可省略。' },
      clearStatistics: { type: 'boolean', description: 'scope=all 时，玩家同时明确要求删除游玩统计才设为 true。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { success: { type: 'boolean', required: true }, message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: async (args) => {
      if (!args.confirmed) throw new Error('删除记忆需要玩家明确确认')
      if (args.scope === 'event') {
        if (args.memoryId === undefined) throw new Error('删除单条记忆需要 memoryId')
        const removed = memory.store.deleteGameMemory(args.memoryId)
        return { success: removed, message: removed ? '已删除这条游戏记忆。' : '没有找到这条游戏记忆。' }
      }
      if (args.scope === 'current-save') {
        const selected = identity(memory, args.gameId, args.saveId)
        if (selected === undefined) throw new Error('无法唯一确定当前存档，请先查看记忆并提供 gameId 和 saveId')
        memory.store.clearGameMemory(selected)
        return { success: true, message: `已清空 ${selected.gameId}/${selected.saveId} 的游戏记忆，存档本身没有改动。` }
      }
      if (args.scope === 'shared') {
        memory.store.clearSharedProfile()
        return { success: true, message: '已清空共同记忆，游戏存档记忆和游玩统计仍保留。' }
      }
      if (args.scope === 'all') {
        memory.store.clearSharedProfile()
        memory.store.clearAllGameMemory()
        if (args.clearStatistics === true) memory.store.clearPlayStatistics()
        return { success: true, message: `已清空全部小汤圆长期记忆${args.clearStatistics === true ? '和游玩统计' : '，游玩统计仍保留'}。` }
      }
      throw new Error('scope 只能是 event、current-save、shared 或 all')
    },
  }))
}
