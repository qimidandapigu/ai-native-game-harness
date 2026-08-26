import type {
  GameAtomExecutor,
  SkillExpression,
  SkillProgram,
  SkillProgramV1,
  SkillRunResult,
  SkillSourceStatement,
  SkillStepTrace,
  SkillValue,
} from './contracts.js'
import { compileSkillSource } from './skill-source.js'

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const ATOM = /^[a-z0-9][a-z0-9._-]{2,79}$/
const MAX_RUNTIME_CALLS = 60

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

function validateV1(program: SkillProgramV1, allowedAtoms?: ReadonlySet<string>): void {
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

export function validateSkillProgram(program: SkillProgram, allowedAtoms?: ReadonlySet<string>): void {
  if (program.language === 'xiaotangyuan-skill-v1') {
    validateV1(program, allowedAtoms)
    return
  }
  if (program.language === 'xiaotangyuan-skill-v2') {
    compileSkillSource(program.source, allowedAtoms)
    return
  }
  throw new Error('不支持的技能程序版本')
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

function isSkillValue(value: unknown, depth = 0): value is SkillValue {
  if (depth > 8) return false
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length <= 50 && value.every(item => isSkillValue(item, depth + 1))
  if (typeof value === 'object') {
    const entries = Object.values(value)
    return entries.length <= 50 && entries.every(item => isSkillValue(item, depth + 1))
  }
  return false
}

class Scope {
  private readonly values = new Map<string, unknown>()

  constructor(private readonly parent?: Scope) {}

  define(name: string, value: unknown): void {
    this.values.set(name, value)
  }

  get(name: string): unknown {
    if (this.values.has(name)) return this.values.get(name)
    return this.parent?.get(name)
  }
}

class RecoverableSkillError extends Error {}
class FatalSkillError extends Error {}
class BreakSignal extends Error {}

interface V2ExecutionState {
  calls: number
  trace: SkillStepTrace[]
  executor: GameAtomExecutor
  signal: AbortSignal
}

function referenceValue(path: string[], scope: Scope): unknown {
  let current = scope.get(path[0] ?? '')
  for (const segment of path.slice(1)) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== ''
}

function evaluate(expression: SkillExpression, scope: Scope): unknown {
  if (expression.kind === 'literal') return expression.value
  if (expression.kind === 'reference') return referenceValue(expression.path, scope)
  if (expression.kind === 'array') return expression.items.map(item => evaluate(item, scope))
  if (expression.kind === 'object') {
    return Object.fromEntries(Object.entries(expression.entries).map(([key, value]) => [key, evaluate(value, scope)]))
  }
  if (expression.kind === 'exists') return evaluate(expression.operand, scope) !== undefined
  if (expression.kind === 'unary') return !truthy(evaluate(expression.operand, scope))
  if (expression.operator === '&&') return truthy(evaluate(expression.left, scope)) && truthy(evaluate(expression.right, scope))
  if (expression.operator === '||') return truthy(evaluate(expression.left, scope)) || truthy(evaluate(expression.right, scope))
  const left = evaluate(expression.left, scope)
  const right = evaluate(expression.right, scope)
  if (expression.operator === '==') return left === right
  if (expression.operator === '!=') return left !== right
  if (typeof left === 'number' && typeof right === 'number') {
    if (expression.operator === '>') return left > right
    if (expression.operator === '>=') return left >= right
    if (expression.operator === '<') return left < right
    return left <= right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (expression.operator === '>') return left > right
    if (expression.operator === '>=') return left >= right
    if (expression.operator === '<') return left < right
    return left <= right
  }
  return false
}

async function executeV2Block(
  statements: SkillSourceStatement[],
  scope: Scope,
  state: V2ExecutionState,
): Promise<void> {
  for (const statement of statements) {
    if (state.signal.aborted) throw state.signal.reason
    if (statement.kind === 'call') {
      state.calls += 1
      if (state.calls > MAX_RUNTIME_CALLS) throw new FatalSkillError(`技能单次运行最多调用 ${MAX_RUNTIME_CALLS} 个游戏原子`)
      const args: Record<string, SkillValue> = {}
      for (const [key, expression] of Object.entries(statement.args)) {
        const value = evaluate(expression, scope)
        if (!isSkillValue(value)) throw new FatalSkillError(`原子参数 ${key} 不是安全值或引用不存在`)
        args[key] = value
      }
      const index = state.trace.length
      try {
        const result = await state.executor(statement.atom, args, state.signal)
        state.trace.push({ index, atom: statement.atom, arguments: args, success: true, result })
        if (statement.saveAs !== undefined) scope.define(statement.saveAs, result)
      } catch (error) {
        if (state.signal.aborted) throw state.signal.reason
        const message = error instanceof Error ? error.message : String(error)
        state.trace.push({ index, atom: statement.atom, arguments: args, success: false, error: message })
        throw new RecoverableSkillError(message)
      }
      continue
    }
    if (statement.kind === 'if') {
      const body = truthy(evaluate(statement.condition, scope)) ? statement.then : statement.else
      if (body !== undefined) await executeV2Block(body, new Scope(scope), state)
      continue
    }
    if (statement.kind === 'repeat') {
      for (let iteration = 0; iteration < statement.count; iteration += 1) {
        try {
          await executeV2Block(statement.body, new Scope(scope), state)
        } catch (error) {
          if (error instanceof BreakSignal) break
          throw error
        }
      }
      continue
    }
    if (statement.kind === 'try') {
      try {
        await executeV2Block(statement.body, new Scope(scope), state)
      } catch (error) {
        if (!(error instanceof RecoverableSkillError)) throw error
        await executeV2Block(statement.fallback, new Scope(scope), state)
      }
      continue
    }
    if (statement.kind === 'assert') {
      if (!truthy(evaluate(statement.condition, scope))) throw new FatalSkillError(statement.message)
      continue
    }
    if (statement.kind === 'fail') throw new FatalSkillError(statement.message)
    throw new BreakSignal()
  }
}

async function runV1(
  skillId: string,
  skillVersion: number,
  program: SkillProgramV1,
  executor: GameAtomExecutor,
  signal: AbortSignal,
): Promise<SkillRunResult> {
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
    if (program.language === 'xiaotangyuan-skill-v1') return runV1(skillId, skillVersion, program, executor, signal)

    const compiled = compileSkillSource(program.source, allowedAtoms)
    const state: V2ExecutionState = { calls: 0, trace: [], executor, signal }
    try {
      await executeV2Block(compiled.body, new Scope(), state)
      return { success: true, skillId, skillVersion, trace: state.trace }
    } catch (error) {
      if (signal.aborted) throw state.signal.reason
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, skillId, skillVersion, trace: state.trace, error: message }
    }
  }
}
