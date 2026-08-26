import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AdapterHello } from '../protocol/game.js'
import type { GameAtomExecutor } from '../runtime/skills/contracts.js'
import type { SkillService } from '../runtime/skills/skill-service.js'

export function registerSkillTools(
  ctx: Context,
  adapter: AdapterHello | undefined,
  skills: SkillService,
  executor: GameAtomExecutor,
): void {
  const gameId = adapter?.gameId ?? 'unknown'
  const available = skills.store.list(gameId)
  const declaredAtoms = adapter?.atoms ?? []
  const allowedAtoms = new Set(declaredAtoms.length > 0
    ? declaredAtoms.map(atom => atom.name)
    : (adapter?.capabilities ?? []).filter(capability =>
        !capability.startsWith('assistant.') && !capability.startsWith('speech.')))
  const atomCatalog = declaredAtoms.length === 0
    ? [...allowedAtoms].join('、')
    : declaredAtoms.map(atom => `${atom.name}：${atom.description}；参数 ${atom.parameters}；返回 ${atom.returns}`).join('\n')
  ctx.tools.register(defineTool({
    name: 'xiaotangyuan_skill_run',
    description: `执行小汤圆已经通过试跑学会的游戏技能。玩家要求实际行动时必须调用；成功与否只以工具结果为准。当前技能：${available.length === 0 ? '暂无，必须先通过学习工具实际试跑' : available.map(skill => `${skill.id}（${skill.triggers.join('、')}）`).join('；')}`,
    parameters: {
      skillId: { type: 'string', required: true, description: '要执行的技能 ID。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          skillId: { type: 'string', required: true },
          skillVersion: { type: 'number', required: true },
          message: { type: 'string', required: true },
          traceJson: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: async (args, exec) => {
      const result = await skills.run(gameId, args.skillId, allowedAtoms, executor, exec.signal)
      return {
        success: result.success,
        skillId: result.skillId,
        skillVersion: result.skillVersion,
        message: result.success ? '技能执行成功。' : `技能执行失败：${result.error}`,
        traceJson: JSON.stringify(result.trace),
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
  }))

  if (allowedAtoms.size === 0) return
  ctx.tools.register(defineTool({
    name: 'xiaotangyuan_skill_learn',
    description: `让小汤圆自己学习或修订技能：你生成候选 xiaotangyuan-skill-v2 源码，本工具先安全编译，再立即调用真实游戏原子逐步试跑；只有整段成功才保存。失败源码和 trace 会进入 learningAttempts，应该依据确切错误修改后重试，同一请求最多三次。\n允许语法：let 变量 = await atom("原子名", { 参数 });、await atom(...)、if (条件) { ... } else { ... }、repeat(1到10) { ... }、try { ... } catch { 回退调用或 fail(...) }、assert(条件, "错误")、fail("错误")、repeat 内 break。条件支持 exists(变量.字段)、!、==、!=、>、>=、<、<=、&&、||。禁止任意 JavaScript、文件、网络、模块、递归和无限循环。\n示例：\nlet tree = await atom("dst.find_nearest_entity", { prefab: "evergreen", radius: 20 });\nlet chopped = await atom("dst.chop_target", { targetId: tree.targetId });\nif (chopped.chopped == true) { await atom("dst.collect_items", { prefab: "log", x: chopped.x, z: chopped.z, radius: 6 }); } else { fail("没有砍倒树"); }\n环境暂时没有目标、距离过远、容器已满等不是语法错误，应优先调整环境或合理使用回退。原子能力目录：\n${atomCatalog}`,
    parameters: {
      skillId: { type: 'string', required: true, description: '稳定技能 ID，例如 dst.hunt-and-collect-butterfly。' },
      name: { type: 'string', required: true, description: '简短技能名称。' },
      description: { type: 'string', required: true, description: '技能要完成的目标。' },
      triggers: { type: 'string', required: true, description: '逗号分隔的玩家触发说法。' },
      sourceCode: { type: 'string', required: true, description: 'xiaotangyuan-skill-v2 技能源码，使用受限的 TypeScript 风格语法。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          learned: { type: 'boolean', required: true },
          skillId: { type: 'string', required: true },
          version: { type: 'number', required: true },
          message: { type: 'string', required: true },
          traceJson: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: async (args, exec) => {
      const attempt = await skills.tryLearnSource({
        gameId, skillId: args.skillId, name: args.name, description: args.description,
        triggers: args.triggers.split(/[,，]/).map(item => item.trim()).filter(Boolean),
        sourceCode: args.sourceCode,
      }, allowedAtoms, executor, exec.signal)
      const version = attempt.learned?.version ?? attempt.result.skillVersion
      return {
        success: attempt.result.success,
        learned: attempt.learned !== undefined,
        skillId: attempt.result.skillId,
        version,
        message: attempt.learned === undefined
          ? `这次还没学会：${attempt.result.error}。候选程序没有保存，请根据 trace 判断是否需要修改后再试。`
          : `我实际做成功了，已经把“${attempt.learned.name}”记成第 ${version} 版技能。`,
        traceJson: JSON.stringify(attempt.result.trace),
        ...(attempt.result.error === undefined ? {} : { error: attempt.result.error }),
      }
    },
  }))
}
