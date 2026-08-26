import type { SkillExpression, SkillProgramV2, SkillSourceStatement, SkillValue } from './contracts.js'

type TokenKind = 'identifier' | 'string' | 'number' | 'symbol' | 'eof'
interface Token { kind: TokenKind, value: string, line: number, column: number }

const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const ATOM = /^[a-z0-9][a-z0-9._-]{2,79}$/
const MAX_SOURCE_LENGTH = 12_000
const MAX_AST_NODES = 200
const MAX_NESTING = 8
const MAX_CALL_SITES = 30

function sourceError(message: string, token: Token): Error {
  return new Error(`技能源码第 ${token.line} 行第 ${token.column} 列：${message}`)
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1
  let column = 1
  const advance = (): string => {
    const value = source[index++] ?? ''
    if (value === '\n') { line += 1; column = 1 } else column += 1
    return value
  }
  const push = (kind: TokenKind, value: string, tokenLine: number, tokenColumn: number): void => {
    tokens.push({ kind, value, line: tokenLine, column: tokenColumn })
  }
  while (index < source.length) {
    const current = source[index] ?? ''
    if (/\s/.test(current)) { advance(); continue }
    if (current === '/' && source[index + 1] === '/') {
      while (index < source.length && advance() !== '\n') {}
      continue
    }
    if (current === '/' && source[index + 1] === '*') {
      const start = { kind: 'symbol' as const, value: '/*', line, column }
      advance(); advance()
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) advance()
      if (index >= source.length) throw sourceError('块注释没有结束', start)
      advance(); advance(); continue
    }
    const tokenLine = line
    const tokenColumn = column
    if (current === '"' || current === "'") {
      const quote = advance()
      let value = ''
      let closed = false
      while (index < source.length) {
        const character = advance()
        if (character === quote) { closed = true; break }
        if (character === '\n' || character === '\r') throw sourceError('字符串不能跨行', { kind: 'string', value, line: tokenLine, column: tokenColumn })
        if (character !== '\\') { value += character; continue }
        const escaped = advance()
        if (escaped === 'n') value += '\n'
        else if (escaped === 'r') value += '\r'
        else if (escaped === 't') value += '\t'
        else if (escaped === '"' || escaped === "'" || escaped === '\\' || escaped === '/') value += escaped
        else if (escaped === 'u') {
          const hex = source.slice(index, index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw sourceError('Unicode 转义无效', { kind: 'string', value, line: tokenLine, column: tokenColumn })
          value += String.fromCharCode(Number.parseInt(hex, 16))
          for (let offset = 0; offset < 4; offset += 1) advance()
        } else throw sourceError(`不支持的字符串转义：\\${escaped}`, { kind: 'string', value, line: tokenLine, column: tokenColumn })
      }
      if (!closed) throw sourceError('字符串没有结束', { kind: 'string', value, line: tokenLine, column: tokenColumn })
      push('string', value, tokenLine, tokenColumn); continue
    }
    if (/[A-Za-z_]/.test(current)) {
      let value = ''
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? '')) value += advance()
      push('identifier', value, tokenLine, tokenColumn); continue
    }
    if (/\d/.test(current) || (current === '-' && /\d/.test(source[index + 1] ?? ''))) {
      let value = ''
      if (current === '-') value += advance()
      while (index < source.length && /\d/.test(source[index] ?? '')) value += advance()
      if (source[index] === '.') {
        value += advance()
        while (index < source.length && /\d/.test(source[index] ?? '')) value += advance()
      }
      push('number', value, tokenLine, tokenColumn); continue
    }
    const pair = source.slice(index, index + 2)
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(pair)) {
      advance(); advance(); push('symbol', pair, tokenLine, tokenColumn); continue
    }
    if ('{}()[]:,.;=!<>'.includes(current)) { push('symbol', advance(), tokenLine, tokenColumn); continue }
    throw sourceError(`不支持的字符：${current}`, { kind: 'symbol', value: current, line: tokenLine, column: tokenColumn })
  }
  tokens.push({ kind: 'eof', value: '', line, column })
  return tokens
}

class Parser {
  private readonly tokens: Token[]
  private position = 0
  private nodes = 0
  constructor(source: string) { this.tokens = tokenize(source) }
  parse(): SkillSourceStatement[] {
    const statements: SkillSourceStatement[] = []
    while (!this.at('eof')) statements.push(this.statement(0))
    if (statements.length === 0) throw sourceError('技能源码不能为空', this.current())
    return statements
  }
  private node<T>(value: T): T {
    this.nodes += 1
    if (this.nodes > MAX_AST_NODES) throw sourceError(`技能源码最多包含 ${MAX_AST_NODES} 个语法节点`, this.current())
    return value
  }
  private current(): Token { return this.tokens[this.position] ?? this.tokens[this.tokens.length - 1]! }
  private at(kind: TokenKind, value?: string): boolean {
    const token = this.current()
    return token.kind === kind && (value === undefined || token.value === value)
  }
  private take(kind: TokenKind, value?: string, message?: string): Token {
    const token = this.current()
    if (!this.at(kind, value)) throw sourceError(message ?? `需要 ${value ?? kind}`, token)
    this.position += 1
    return token
  }
  private keyword(value: string): boolean {
    if (!this.at('identifier', value)) return false
    this.position += 1
    return true
  }
  private optionalSemicolon(): void { if (this.at('symbol', ';')) this.position += 1 }
  private statement(depth: number): SkillSourceStatement {
    if (depth > MAX_NESTING) throw sourceError(`技能控制结构最多嵌套 ${MAX_NESTING} 层`, this.current())
    if (this.keyword('let')) {
      const variable = this.take('identifier', undefined, 'let 后需要变量名')
      if (!IDENTIFIER.test(variable.value)) throw sourceError('变量名无效', variable)
      this.take('symbol', '=', '变量声明需要 =')
      const call = this.call(); this.optionalSemicolon()
      return this.node({ ...call, saveAs: variable.value })
    }
    if (this.at('identifier', 'await')) { const call = this.call(); this.optionalSemicolon(); return this.node(call) }
    if (this.keyword('if')) {
      this.take('symbol', '(', 'if 后需要条件括号')
      const condition = this.expression()
      this.take('symbol', ')', 'if 条件缺少右括号')
      const then = this.block(depth + 1)
      const otherwise = this.keyword('else') ? this.block(depth + 1) : undefined
      return this.node({ kind: 'if', condition, then, ...(otherwise === undefined ? {} : { else: otherwise }) })
    }
    if (this.keyword('repeat')) {
      this.take('symbol', '(', 'repeat 后需要次数括号')
      const countToken = this.take('number', undefined, 'repeat 次数必须是整数')
      const count = Number(countToken.value)
      if (!Number.isInteger(count) || count < 1 || count > 10) throw sourceError('repeat 次数必须在 1 到 10 之间', countToken)
      this.take('symbol', ')', 'repeat 次数缺少右括号')
      return this.node({ kind: 'repeat', count, body: this.block(depth + 1) })
    }
    if (this.keyword('try')) {
      const body = this.block(depth + 1)
      this.take('identifier', 'catch', 'try 后必须提供 catch 回退代码')
      return this.node({ kind: 'try', body, fallback: this.block(depth + 1) })
    }
    if (this.keyword('assert')) {
      this.take('symbol', '(', 'assert 后需要括号')
      const condition = this.expression()
      let message = '技能断言失败'
      if (this.at('symbol', ',')) { this.position += 1; message = this.take('string', undefined, 'assert 的第二个参数必须是错误文字').value }
      this.take('symbol', ')', 'assert 缺少右括号'); this.optionalSemicolon()
      return this.node({ kind: 'assert', condition, message: message.slice(0, 300) })
    }
    if (this.keyword('fail')) {
      this.take('symbol', '(', 'fail 后需要括号')
      const message = this.take('string', undefined, 'fail 需要错误文字').value
      this.take('symbol', ')', 'fail 缺少右括号'); this.optionalSemicolon()
      return this.node({ kind: 'fail', message: message.slice(0, 300) })
    }
    if (this.keyword('break')) { this.optionalSemicolon(); return this.node({ kind: 'break' }) }
    throw sourceError('不支持的语句；只允许 let/await/if/repeat/try/assert/fail/break', this.current())
  }
  private block(depth: number): SkillSourceStatement[] {
    this.take('symbol', '{', '需要代码块 { }')
    const statements: SkillSourceStatement[] = []
    while (!this.at('symbol', '}')) {
      if (this.at('eof')) throw sourceError('代码块没有结束', this.current())
      statements.push(this.statement(depth))
    }
    this.take('symbol', '}')
    return statements
  }
  private call(): Extract<SkillSourceStatement, { kind: 'call' }> {
    this.take('identifier', 'await', '原子调用必须以 await 开头')
    this.take('identifier', 'atom', '只允许调用 atom')
    this.take('symbol', '(', 'atom 后需要括号')
    const atom = this.take('string', undefined, 'atom 的第一个参数必须是原子名称').value
    if (!ATOM.test(atom)) throw sourceError('原子能力名称无效', this.current())
    let args: Record<string, SkillExpression> = {}
    if (this.at('symbol', ',')) {
      this.position += 1
      const expression = this.expression()
      if (expression.kind !== 'object') throw sourceError('atom 的第二个参数必须是对象', this.current())
      args = expression.entries
    }
    this.take('symbol', ')', 'atom 调用缺少右括号')
    return { kind: 'call', atom, args }
  }
  private expression(): SkillExpression { return this.or() }
  private or(): SkillExpression {
    let left = this.and()
    while (this.at('symbol', '||')) { this.position += 1; left = this.node({ kind: 'binary', operator: '||', left, right: this.and() }) }
    return left
  }
  private and(): SkillExpression {
    let left = this.equality()
    while (this.at('symbol', '&&')) { this.position += 1; left = this.node({ kind: 'binary', operator: '&&', left, right: this.equality() }) }
    return left
  }
  private equality(): SkillExpression {
    let left = this.comparison()
    while (this.at('symbol', '==') || this.at('symbol', '!=')) {
      const operator = this.take('symbol').value as '==' | '!='
      left = this.node({ kind: 'binary', operator, left, right: this.comparison() })
    }
    return left
  }
  private comparison(): SkillExpression {
    let left = this.unary()
    while (['>', '>=', '<', '<='].some(operator => this.at('symbol', operator))) {
      const operator = this.take('symbol').value as '>' | '>=' | '<' | '<='
      left = this.node({ kind: 'binary', operator, left, right: this.unary() })
    }
    return left
  }
  private unary(): SkillExpression {
    if (this.at('symbol', '!')) { this.position += 1; return this.node({ kind: 'unary', operator: '!', operand: this.unary() }) }
    return this.primary()
  }
  private primary(): SkillExpression {
    const token = this.current()
    if (this.at('string')) { this.position += 1; return this.node({ kind: 'literal', value: token.value }) }
    if (this.at('number')) { this.position += 1; return this.node({ kind: 'literal', value: Number(token.value) }) }
    if (this.keyword('true')) return this.node({ kind: 'literal', value: true })
    if (this.keyword('false')) return this.node({ kind: 'literal', value: false })
    if (this.keyword('null')) return this.node({ kind: 'literal', value: null })
    if (this.keyword('exists')) {
      this.take('symbol', '(', 'exists 后需要括号')
      const operand = this.expression()
      this.take('symbol', ')', 'exists 缺少右括号')
      return this.node({ kind: 'exists', operand })
    }
    if (this.at('identifier')) {
      const path = [this.take('identifier').value]
      while (this.at('symbol', '.')) { this.position += 1; path.push(this.take('identifier', undefined, '属性访问需要字段名').value) }
      return this.node({ kind: 'reference', path })
    }
    if (this.at('symbol', '(')) {
      this.position += 1
      const expression = this.expression()
      this.take('symbol', ')', '表达式缺少右括号')
      return expression
    }
    if (this.at('symbol', '[')) {
      this.position += 1
      const items: SkillExpression[] = []
      while (!this.at('symbol', ']')) { items.push(this.expression()); if (!this.at('symbol', ',')) break; this.position += 1 }
      this.take('symbol', ']', '数组缺少右方括号')
      return this.node({ kind: 'array', items })
    }
    if (this.at('symbol', '{')) {
      this.position += 1
      const entries: Record<string, SkillExpression> = {}
      while (!this.at('symbol', '}')) {
        const key = this.at('identifier') ? this.take('identifier').value : this.take('string', undefined, '对象字段名无效').value
        if (Object.hasOwn(entries, key)) throw sourceError(`对象字段重复：${key}`, this.current())
        this.take('symbol', ':', '对象字段缺少冒号')
        entries[key] = this.expression()
        if (!this.at('symbol', ',')) break
        this.position += 1
      }
      this.take('symbol', '}', '对象缺少右花括号')
      return this.node({ kind: 'object', entries })
    }
    throw sourceError('表达式无效', token)
  }
}

function validateExpression(expression: SkillExpression, variables: ReadonlySet<string>, depth = 0): void {
  if (depth > MAX_NESTING) throw new Error(`技能表达式最多嵌套 ${MAX_NESTING} 层`)
  if (expression.kind === 'literal') {
    const visit = (value: SkillValue, valueDepth = 0): void => {
      if (valueDepth > MAX_NESTING) throw new Error('技能字面量嵌套过深')
      if (typeof value === 'string' && value.length > 500) throw new Error('技能字符串参数过长')
      if (Array.isArray(value)) value.forEach(item => visit(item, valueDepth + 1))
      else if (typeof value === 'object' && value !== null) Object.values(value).forEach(item => visit(item, valueDepth + 1))
    }
    visit(expression.value); return
  }
  if (expression.kind === 'reference') {
    const root = expression.path[0] ?? ''
    if (!variables.has(root)) throw new Error(`技能引用了尚未定义的变量：${root}`)
    return
  }
  if (expression.kind === 'array') {
    if (expression.items.length > 50) throw new Error('技能数组参数过长')
    expression.items.forEach(item => validateExpression(item, variables, depth + 1)); return
  }
  if (expression.kind === 'object') {
    if (Object.keys(expression.entries).length > 50) throw new Error('技能对象参数字段过多')
    Object.values(expression.entries).forEach(item => validateExpression(item, variables, depth + 1)); return
  }
  if (expression.kind === 'binary') {
    validateExpression(expression.left, variables, depth + 1); validateExpression(expression.right, variables, depth + 1); return
  }
  validateExpression(expression.operand, variables, depth + 1)
}

function hasFallbackOutcome(statements: SkillSourceStatement[]): boolean {
  return statements.some(statement => {
    if (statement.kind === 'call' || statement.kind === 'fail' || statement.kind === 'assert') return true
    if (statement.kind === 'if') return hasFallbackOutcome(statement.then) || hasFallbackOutcome(statement.else ?? [])
    if (statement.kind === 'repeat') return hasFallbackOutcome(statement.body)
    if (statement.kind === 'try') return hasFallbackOutcome(statement.body) || hasFallbackOutcome(statement.fallback)
    return false
  })
}

export function validateSkillSourceProgram(program: SkillProgramV2, allowedAtoms?: ReadonlySet<string>): void {
  if (program.source.length < 1 || program.source.length > MAX_SOURCE_LENGTH) throw new Error(`技能源码长度必须在 1 到 ${MAX_SOURCE_LENGTH} 字符之间`)
  if (!Array.isArray(program.body) || program.body.length === 0) throw new Error('技能源码没有可执行语句')
  let callSites = 0
  const validateBlock = (statements: SkillSourceStatement[], inherited: ReadonlySet<string>, loopDepth: number, nesting: number): void => {
    if (nesting > MAX_NESTING) throw new Error(`技能控制结构最多嵌套 ${MAX_NESTING} 层`)
    const variables = new Set(inherited)
    const localVariables = new Set<string>()
    for (const statement of statements) {
      if (statement.kind === 'call') {
        callSites += 1
        if (!ATOM.test(statement.atom)) throw new Error('技能包含无效原子能力')
        if (allowedAtoms !== undefined && !allowedAtoms.has(statement.atom)) throw new Error(`游戏未声明原子能力：${statement.atom}`)
        Object.values(statement.args).forEach(expression => validateExpression(expression, variables))
        if (statement.saveAs !== undefined) {
          if (!IDENTIFIER.test(statement.saveAs) || localVariables.has(statement.saveAs)) throw new Error(`技能变量名无效或重复：${statement.saveAs}`)
          localVariables.add(statement.saveAs); variables.add(statement.saveAs)
        }
      } else if (statement.kind === 'if') {
        validateExpression(statement.condition, variables)
        validateBlock(statement.then, variables, loopDepth, nesting + 1)
        if (statement.else !== undefined) validateBlock(statement.else, variables, loopDepth, nesting + 1)
      } else if (statement.kind === 'repeat') {
        if (!Number.isInteger(statement.count) || statement.count < 1 || statement.count > 10) throw new Error('repeat 次数必须在 1 到 10 之间')
        validateBlock(statement.body, variables, loopDepth + 1, nesting + 1)
      } else if (statement.kind === 'try') {
        if (!hasFallbackOutcome(statement.fallback)) throw new Error('catch 不能只吞掉错误，必须执行回退原子、断言或 fail')
        validateBlock(statement.body, variables, loopDepth, nesting + 1)
        validateBlock(statement.fallback, variables, loopDepth, nesting + 1)
      } else if (statement.kind === 'assert') validateExpression(statement.condition, variables)
      else if (statement.kind === 'break' && loopDepth === 0) throw new Error('break 只能出现在 repeat 中')
    }
  }
  validateBlock(program.body, new Set(), 0, 0)
  if (callSites < 1) throw new Error('技能源码至少要调用一个游戏原子能力')
  if (callSites > MAX_CALL_SITES) throw new Error(`技能源码最多包含 ${MAX_CALL_SITES} 个原子调用位置`)
}

export function compileSkillSource(source: string, allowedAtoms?: ReadonlySet<string>): SkillProgramV2 {
  const normalized = source.trim()
  if (normalized.length > MAX_SOURCE_LENGTH) throw new Error(`技能源码最多 ${MAX_SOURCE_LENGTH} 个字符`)
  const program: SkillProgramV2 = { language: 'xiaotangyuan-skill-v2', source: normalized, body: new Parser(normalized).parse() }
  validateSkillSourceProgram(program, allowedAtoms)
  return program
}
