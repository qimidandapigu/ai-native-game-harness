export type SkillScalar = string | number | boolean | null
export type SkillValue = SkillScalar | SkillValue[] | { [key: string]: SkillValue }

export interface SkillCallStep {
  op: 'call'
  atom: string
  args?: Record<string, SkillValue>
  saveAs?: string
}

export interface SkillProgramV1 {
  language: 'xiaotangyuan-skill-v1'
  steps: SkillCallStep[]
}

export type SkillBinaryOperator = '==' | '!=' | '>' | '>=' | '<' | '<=' | '&&' | '||'

export type SkillExpression =
  | { kind: 'literal', value: SkillValue }
  | { kind: 'reference', path: string[] }
  | { kind: 'array', items: SkillExpression[] }
  | { kind: 'object', entries: Record<string, SkillExpression> }
  | { kind: 'unary', operator: '!', operand: SkillExpression }
  | { kind: 'binary', operator: SkillBinaryOperator, left: SkillExpression, right: SkillExpression }
  | { kind: 'exists', operand: SkillExpression }

export interface SkillSourceCallStatement {
  kind: 'call'
  atom: string
  args: Record<string, SkillExpression>
  saveAs?: string
}

export interface SkillSourceIfStatement {
  kind: 'if'
  condition: SkillExpression
  then: SkillSourceStatement[]
  else?: SkillSourceStatement[]
}

export interface SkillSourceRepeatStatement {
  kind: 'repeat'
  count: number
  body: SkillSourceStatement[]
}

export interface SkillSourceTryStatement {
  kind: 'try'
  body: SkillSourceStatement[]
  fallback: SkillSourceStatement[]
}

export type SkillSourceStatement =
  | SkillSourceCallStatement
  | SkillSourceIfStatement
  | SkillSourceRepeatStatement
  | SkillSourceTryStatement
  | { kind: 'assert', condition: SkillExpression, message: string }
  | { kind: 'fail', message: string }
  | { kind: 'break' }

export interface SkillProgramV2 {
  language: 'xiaotangyuan-skill-v2'
  source: string
  body: SkillSourceStatement[]
}

export type SkillProgram = SkillProgramV1 | SkillProgramV2

export interface SkillRecord {
  id: string
  gameId: string
  name: string
  description: string
  triggers: string[]
  version: number
  status: 'active' | 'archived'
  program: SkillProgram
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  successCount: number
  failureCount: number
  lastError?: string
}

export interface SkillStepTrace {
  index: number
  atom: string
  arguments: Record<string, SkillValue>
  success: boolean
  result?: unknown
  error?: string
}

export interface SkillRunResult {
  success: boolean
  skillId: string
  skillVersion: number
  trace: SkillStepTrace[]
  error?: string
}

export interface SkillLearningAttempt {
  gameId: string
  skillId: string
  proposedVersion: number
  program: SkillProgram
  success: boolean
  trace: SkillStepTrace[]
  error?: string
  createdAt: string
}

export type GameAtomExecutor = (
  atom: string,
  args: Record<string, SkillValue>,
  signal: AbortSignal,
) => Promise<unknown>
