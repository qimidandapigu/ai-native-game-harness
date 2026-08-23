export type SkillScalar = string | number | boolean | null
export type SkillValue = SkillScalar | SkillValue[] | { [key: string]: SkillValue }

export interface SkillCallStep {
  op: 'call'
  atom: string
  args?: Record<string, SkillValue>
  saveAs?: string
}

export interface SkillProgram {
  language: 'xiaotangyuan-skill-v1'
  steps: SkillCallStep[]
}

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
