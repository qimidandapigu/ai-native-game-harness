import type { SkillProgram, SkillRecord, SkillRunResult, GameAtomExecutor } from './contracts.js'
import { SkillRuntime, validateSkillProgram } from './skill-runtime.js'
import { SkillStore } from './skill-store.js'

export class SkillService {
  readonly store: SkillStore
  private readonly runtime = new SkillRuntime()

  constructor(store: SkillStore) {
    this.store = store
  }

  private saveGenerated(input: {
    gameId: string
    skillId: string
    name: string
    description: string
    triggers: string[]
    program: SkillProgram
  }, allowedAtoms: ReadonlySet<string>): SkillRecord {
    validateSkillProgram(input.program, allowedAtoms)
    const previous = this.store.find(input.gameId, input.skillId)
    const now = new Date().toISOString()
    return this.store.upsert({
      id: input.skillId,
      gameId: input.gameId,
      name: input.name.trim().slice(0, 80),
      description: input.description.trim().slice(0, 500),
      triggers: input.triggers.map(value => value.slice(0, 80)).slice(0, 20),
      version: (previous?.version ?? 0) + 1,
      status: 'active',
      program: input.program,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      successCount: previous?.successCount ?? 0,
      failureCount: previous?.failureCount ?? 0,
      ...(previous?.lastUsedAt === undefined ? {} : { lastUsedAt: previous.lastUsedAt }),
    })
  }

  async tryLearn(input: {
    gameId: string
    skillId: string
    name: string
    description: string
    triggers: string[]
    program: SkillProgram
  }, allowedAtoms: ReadonlySet<string>, executor: GameAtomExecutor, signal: AbortSignal): Promise<{
    result: SkillRunResult
    learned?: SkillRecord
  }> {
    validateSkillProgram(input.program, allowedAtoms)
    const proposedVersion = (this.store.find(input.gameId, input.skillId)?.version ?? 0) + 1
    const result = await this.runtime.run(
      input.skillId,
      proposedVersion,
      input.program,
      allowedAtoms,
      executor,
      signal,
    )
    this.store.recordLearningAttempt({
      gameId: input.gameId,
      skillId: input.skillId,
      proposedVersion,
      program: input.program,
      success: result.success,
      trace: result.trace,
      ...(result.error === undefined ? {} : { error: result.error }),
      createdAt: new Date().toISOString(),
    })
    if (!result.success) return { result }
    return { result, learned: this.saveGenerated(input, allowedAtoms) }
  }

  async run(
    gameId: string,
    skillId: string,
    allowedAtoms: ReadonlySet<string>,
    executor: GameAtomExecutor,
    signal: AbortSignal,
  ): Promise<SkillRunResult> {
    const skill = this.store.get(gameId, skillId)
    if (skill === undefined) throw new Error(`没有找到可用技能：${skillId}`)
    const result = await this.runtime.run(skill.id, skill.version, skill.program, allowedAtoms, executor, signal)
    this.store.recordRun(gameId, skillId, result.success, result.error)
    return result
  }
}
