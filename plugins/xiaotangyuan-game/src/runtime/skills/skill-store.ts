import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResolvedConfig } from '../../config.js'
import type { SkillLearningAttempt, SkillRecord } from './contracts.js'
import { validateSkillProgram } from './skill-runtime.js'

interface SkillDocument {
  schemaVersion: 1
  skills: SkillRecord[]
  history: SkillRecord[]
  learningAttempts: SkillLearningAttempt[]
}

export class SkillStore {
  private readonly path: string
  private document: SkillDocument

  constructor(private readonly config: ResolvedConfig['skills']) {
    mkdirSync(config.directory, { recursive: true })
    this.path = join(config.directory, 'skills-v1.json')
    this.document = this.load()
    this.removeLegacyBootstrapSkill()
  }

  private load(): SkillDocument {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as SkillDocument
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.skills)) {
        return {
          ...parsed,
          history: Array.isArray(parsed.history) ? parsed.history : [],
          learningAttempts: Array.isArray(parsed.learningAttempts) ? parsed.learningAttempts : [],
        }
      }
    } catch {}
    return { schemaVersion: 1, skills: [], history: [], learningAttempts: [] }
  }

  private save(): void {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.document, null, 2), 'utf8')
    renameSync(temporary, this.path)
  }

  private removeLegacyBootstrapSkill(): void {
    const index = this.document.skills.findIndex(skill =>
      skill.id === 'dst.hunt-and-collect-butterfly'
      && skill.gameId === 'dont-starve-together'
      && skill.version === 1
      && skill.name === '打蝴蝶并捡起掉落'
      && !this.document.learningAttempts.some(attempt =>
        attempt.gameId === skill.gameId && attempt.skillId === skill.id && attempt.success))
    if (index >= 0) {
      const legacySkill = this.document.skills[index]
      if (legacySkill === undefined) return
      this.document.history.push({ ...legacySkill, status: 'archived' })
      this.document.skills.splice(index, 1)
      this.save()
    }
  }

  get(gameId: string, skillId: string): SkillRecord | undefined {
    return this.document.skills.find(skill => skill.gameId === gameId && skill.id === skillId && skill.status === 'active')
  }

  find(gameId: string, skillId: string): SkillRecord | undefined {
    return this.document.skills.find(skill => skill.gameId === gameId && skill.id === skillId)
  }

  list(gameId: string): SkillRecord[] {
    return this.document.skills.filter(skill => skill.gameId === gameId && skill.status === 'active')
  }

  listLearningAttempts(gameId?: string, limit = 100): SkillLearningAttempt[] {
    return this.document.learningAttempts
      .filter(attempt => gameId === undefined || attempt.gameId === gameId)
      .slice(-Math.max(0, limit))
      .map(attempt => structuredClone(attempt))
  }

  upsert(record: SkillRecord): SkillRecord {
    if (!/^[a-z0-9][a-z0-9._-]{2,99}$/.test(record.id)) throw new Error('技能 ID 无效')
    if (record.name.trim() === '' || record.description.trim() === '') throw new Error('技能名称和描述不能为空')
    validateSkillProgram(record.program)
    const index = this.document.skills.findIndex(skill => skill.gameId === record.gameId && skill.id === record.id)
    const now = new Date().toISOString()
    const next = { ...record, updatedAt: now }
    if (index < 0) this.document.skills.push(next)
    else {
      const previous = this.document.skills[index]
      if (previous === undefined) throw new Error('技能索引失效')
      this.document.history.push({ ...previous, status: 'archived' })
      this.document.history = this.document.history.slice(-100)
      this.document.skills[index] = next
    }
    this.enforceLimit(record.gameId, record.id)
    this.save()
    return next
  }

  recordRun(gameId: string, skillId: string, success: boolean, error?: string): void {
    const skill = this.document.skills.find(item => item.gameId === gameId && item.id === skillId)
    if (skill === undefined) return
    skill.lastUsedAt = new Date().toISOString()
    skill.successCount += success ? 1 : 0
    skill.failureCount += success ? 0 : 1
    skill.lastError = success ? undefined : error
    this.save()
  }

  recordLearningAttempt(attempt: SkillLearningAttempt): void {
    this.document.learningAttempts.push(attempt)
    this.document.learningAttempts = this.document.learningAttempts.slice(-100)
    this.save()
  }

  private enforceLimit(gameId: string, protectedId: string): void {
    const active = this.document.skills.filter(skill => skill.gameId === gameId && skill.status === 'active')
    while (active.length > this.config.activeLimit) {
      const candidates = active.filter(skill => skill.id !== protectedId)
      const forgotten = candidates.sort((a, b) => {
        const aScore = a.successCount * 3 - a.failureCount + (a.lastUsedAt === undefined ? 0 : 1)
        const bScore = b.successCount * 3 - b.failureCount + (b.lastUsedAt === undefined ? 0 : 1)
        return aScore - bScore || a.updatedAt.localeCompare(b.updatedAt)
      })[0]
      if (forgotten === undefined) break
      forgotten.status = 'archived'
      active.splice(active.indexOf(forgotten), 1)
    }
  }
}
