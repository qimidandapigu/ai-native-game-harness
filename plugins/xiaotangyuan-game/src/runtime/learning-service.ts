import { Service, type Context } from '@deepseek-ai/cordis'
import type { MemoryService } from './memory/memory-service.js'
import type { SkillService } from './skills/skill-service.js'
import type { SkillLearningAttempt, SkillRecord } from './skills/contracts.js'

export type ProductSkillSummary = Omit<SkillRecord, 'program' | 'lastError'> & { stepCount: number }
export interface ProductSkillAttemptSummary {
  gameId: string
  skillId: string
  proposedVersion: number
  success: boolean
  error?: string
  createdAt: string
  stepCount: number
  failedStep?: number
}

export interface ProductLearningSnapshot {
  schemaVersion: 1
  updatedAt: string
  enabled: {
    memory: boolean
    skills: boolean
  }
  activeGameId?: string
  memories: ReturnType<MemoryService['store']['listAllGameMemory']>
  playStatistics: ReturnType<MemoryService['store']['listPlayStatistics']>
  skills: ProductSkillSummary[]
  skillAttempts: ProductSkillAttemptSummary[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xiaotangyuanLearning: XiaoTangYuanLearningService
  }
}

/**
 * The single owner of XiaoTangYuan's existing memory and verified-skill stores.
 * Product bindings may consume this service without creating another Agent or
 * another persistence format.
 */
export class XiaoTangYuanLearningService extends Service {
  constructor(
    ctx: Context,
    readonly memory: MemoryService | undefined,
    readonly skills: SkillService | undefined,
  ) {
    super(ctx, 'xiaotangyuanLearning')
  }

  snapshot(activeGameId?: string): ProductLearningSnapshot {
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      enabled: {
        memory: this.memory !== undefined,
        skills: this.skills !== undefined,
      },
      ...(activeGameId === undefined ? {} : { activeGameId }),
      memories: this.memory?.store.listAllGameMemory() ?? [],
      playStatistics: this.memory?.store.listPlayStatistics() ?? [],
      skills: activeGameId === undefined || this.skills === undefined
        ? []
        : this.skills.store.list(activeGameId).map(({ program, lastError: _lastError, ...skill }) => ({ ...skill, stepCount: program.steps.length })),
      skillAttempts: (this.skills?.store.listLearningAttempts(activeGameId, 30) ?? []).map(summarizeAttempt),
    }
  }
}

function summarizeAttempt(attempt: SkillLearningAttempt): ProductSkillAttemptSummary {
  const failedStep = attempt.trace.find(step => !step.success)?.index
  return {
    gameId: attempt.gameId,
    skillId: attempt.skillId,
    proposedVersion: attempt.proposedVersion,
    success: attempt.success,
    ...(attempt.error === undefined ? {} : { error: attempt.error.slice(0, 500) }),
    createdAt: attempt.createdAt,
    stepCount: attempt.program.steps.length,
    ...(failedStep === undefined ? {} : { failedStep }),
  }
}
