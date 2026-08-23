import type {
  GameAtomExecutor,
  SkillProgram,
  SkillRunResult,
  SkillStepTrace,
  SkillValue,
} from './contracts.js'

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const ATOM = /^[a-z0-9][a-z0-9._-]{2,79}$/

function visit(value: SkillValue, depth = 0): void {
  if (depth > 8) throw new Error('技能参数嵌套过深')
  if (typeof value === 'string' && value.length > 500) throw new Error('技能字符串参数过长')
  if (Array.isArray(value)) {
    if (value.length > 50) throw new Error('技能数组参数过长')
    value.forEach(item => visit(item, depth + 1))
  } else if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length > 50) throw new Error('技能对象参数字段过多')
    entries.forEach(([, item]) => visit(item, depth + 1))
  }
}

export function validateSkillProgram(program: SkillProgram, allowedAtoms?: ReadonlySet<string>): void {
  if (program.language !== 'xiaotangyuan-skill-v1') throw new Error('不支持的技能程序版本')
  if (!Array.isArray(program.steps) || program.steps.length < 1 || program.steps.length > 20) {
    throw new Error('技能必须包含 1-20 个步骤')
  }
  for (const step of program.steps) {
    if (step.op !== 'call' || !ATOM.test(step.atom)) throw new Error('技能包含无效原子能力')
    if (allowedAtoms !== undefined && !allowedAtoms.has(step.atom)) throw new Error(`游戏未声明原子能力：${step.atom}`)
    if (step.saveAs !== undefined && !IDENTIFIER.test(step.saveAs)) throw new Error('技能结果变量名无效')
    for (const value of Object.values(step.args ?? {})) visit(value)
  }
}

function resolveReference(value: SkillValue, variables: Map<string, unknown>): SkillValue {
  if (typeof value === 'string' && value.startsWith('$')) {
    const path = value.slice(1).split('.')
    let current: unknown = variables.get(path.shift() ?? '')
    for (const segment of path) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new Error(`技能引用不存在：${value}`)
      }
      current = (current as Record<string, unknown>)[segment]
    }
    if (current === undefined) throw new Error(`技能引用不存在：${value}`)
    return current as SkillValue
  }
  if (Array.isArray(value)) return value.map(item => resolveReference(item, variables))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReference(item, variables)]))
  }
  return value
}

export class SkillRuntime {
  async run(
    skillId: string,
    skillVersion: number,
    program: SkillProgram,
    allowedAtoms: ReadonlySet<string>,
    executor: GameAtomExecutor,
    signal: AbortSignal,
  ): Promise<SkillRunResult> {
    validateSkillProgram(program, allowedAtoms)
    const variables = new Map<string, unknown>()
    const trace: SkillStepTrace[] = []
    for (const [index, step] of program.steps.entries()) {
      if (signal.aborted) throw signal.reason
      let args: Record<string, SkillValue> = {}
      try {
        args = Object.fromEntries(Object.entries(step.args ?? {}).map(([key, value]) => [key, resolveReference(value, variables)]))
        const result = await executor(step.atom, args, signal)
        trace.push({ index, atom: step.atom, arguments: args, success: true, result })
        if (step.saveAs !== undefined) variables.set(step.saveAs, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        trace.push({ index, atom: step.atom, arguments: args, success: false, error: message })
        return { success: false, skillId, skillVersion, trace, error: message }
      }
    }
    return { success: true, skillId, skillVersion, trace }
  }
}
