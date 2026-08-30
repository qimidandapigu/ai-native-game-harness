import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { XiaoTangYuanLearningService } from '../src/runtime/learning-service.js'
import { SkillRuntime, validateSkillProgram } from '../src/runtime/skills/skill-runtime.js'
import { SkillStore } from '../src/runtime/skills/skill-store.js'
import { SkillService } from '../src/runtime/skills/skill-service.js'
import { compileSkillSource } from '../src/runtime/skills/skill-source.js'
import type { SkillProgram, SkillRecord } from '../src/runtime/skills/contracts.js'

const temporary: string[] = []
afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true })
})
describe('shared executable skill runtime', () => {
  it('starts without giving the companion a preinstalled butterfly skill', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const store = new SkillStore({ enabled: true, directory, activeLimit: 10 })
    expect(store.list('dont-starve-together')).toEqual([])
  })

  it('composes declared game atoms and resolves previous step results', async () => {
    const program: SkillProgram = {
      language: 'xiaotangyuan-skill-v1',
      steps: [
        { op: 'call', atom: 'dst.find', saveAs: 'target' },
        { op: 'call', atom: 'dst.attack', args: { targetId: '$target.targetId' } },
      ],
    }
    const calls: Array<[string, Record<string, unknown>]> = []
    const result = await new SkillRuntime().run(
      'test', 1, program, new Set(['dst.find', 'dst.attack']),
      async (atom, args) => {
        calls.push([atom, args])
        return atom === 'dst.find' ? { targetId: 42 } : { defeated: true }
      },
      new AbortController().signal,
    )
    expect(result.success).toBe(true)
    expect(calls).toEqual([['dst.find', {}], ['dst.attack', { targetId: 42 }]])
  })

  it('stops at an atom error and returns an editable execution trace', async () => {
    const program: SkillProgram = {
      language: 'xiaotangyuan-skill-v1',
      steps: [{ op: 'call', atom: 'dst.find' }, { op: 'call', atom: 'dst.attack' }],
    }
    const result = await new SkillRuntime().run(
      'test', 3, program, new Set(['dst.find', 'dst.attack']),
      async atom => { if (atom === 'dst.find') throw new Error('附近没有目标'); return {} },
      new AbortController().signal,
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('附近没有目标')
    expect(result.trace).toHaveLength(1)
  })

  it('compiles and runs v2 source with variables, conditions and bounded loops', async () => {
    const program = compileSkillSource(`
      let target = await atom("dst.find", { prefab: "evergreen", radius: 20 });
      assert(target.targetId == 42, "目标不正确");
      if (target.prefab == "evergreen") {
        repeat(2) {
          await atom("dst.chop", { targetId: target.targetId });
        }
      } else {
        fail("不是常青树");
      }
    `, new Set(['dst.find', 'dst.chop']))
    const calls: Array<[string, Record<string, unknown>]> = []
    const result = await new SkillRuntime().run(
      'dst.chop-tree', 1, program, new Set(['dst.find', 'dst.chop']),
      async (atom, args) => {
        calls.push([atom, args])
        return atom === 'dst.find' ? { targetId: 42, prefab: 'evergreen' } : { chopped: true }
      },
      new AbortController().signal,
    )
    expect(result.success).toBe(true)
    expect(program.source).toContain('repeat(2)')
    expect(calls).toEqual([
      ['dst.find', { prefab: 'evergreen', radius: 20 }],
      ['dst.chop', { targetId: 42 }],
      ['dst.chop', { targetId: 42 }],
    ])
  })

  it('runs a v2 fallback after a real atom error and keeps both trace entries', async () => {
    const program = compileSkillSource(`
      try {
        await atom("dst.primary", {});
      } catch {
        await atom("dst.fallback", {});
      }
    `, new Set(['dst.primary', 'dst.fallback']))
    const result = await new SkillRuntime().run(
      'dst.fallback', 2, program, new Set(['dst.primary', 'dst.fallback']),
      async atom => {
        if (atom === 'dst.primary') throw new Error('主方案失败')
        return { recovered: true }
      },
      new AbortController().signal,
    )
    expect(result.success).toBe(true)
    expect(result.trace.map(item => item.success)).toEqual([false, true])
  })

  it('rejects unsafe or unbounded v2 source before execution', () => {
    expect(() => compileSkillSource('while (true) { await atom("dst.find", {}); }', new Set(['dst.find']))).toThrow('不支持的语句')
    expect(() => compileSkillSource('repeat(11) { await atom("dst.find", {}); }', new Set(['dst.find']))).toThrow('1 到 10')
    expect(() => compileSkillSource('await atom("dst.delete_world", {});', new Set(['dst.find']))).toThrow('游戏未声明原子能力')
    expect(() => compileSkillSource('try { await atom("dst.find", {}); } catch { break; }', new Set(['dst.find']))).toThrow('catch 不能只吞掉错误')
  })

  it('rejects undeclared atoms before executing code', () => {
    expect(() => validateSkillProgram({
      language: 'xiaotangyuan-skill-v1',
      steps: [{ op: 'call', atom: 'dst.delete_world' }],
    }, new Set(['dst.find']))).toThrow('游戏未声明原子能力')
  })

  it('keeps at most five active skills and archives instead of deleting', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const store = new SkillStore({ enabled: true, directory, activeLimit: 5 })
    const now = new Date().toISOString()
    for (let index = 0; index < 6; index += 1) {
      const record: SkillRecord = {
        id: `dst.test-${index}`, gameId: 'dont-starve-together', name: `test ${index}`,
        description: 'test', triggers: ['test'], version: 1, status: 'active',
        program: { language: 'xiaotangyuan-skill-v1', steps: [{ op: 'call', atom: 'dst.test' }] },
        createdAt: now, updatedAt: now, successCount: 0, failureCount: 0,
      }
      store.upsert(record)
    }
    expect(store.list('dont-starve-together')).toHaveLength(5)
    expect(store.get('dont-starve-together', 'dst.test-5')).toBeDefined()
  })

  it('saves a generated skill only after its real execution succeeds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const store = new SkillStore({ enabled: true, directory, activeLimit: 10 })
    const service = new SkillService(store)
    const input = {
      gameId: 'dont-starve-together', skillId: 'dst.learned', name: 'learned',
      description: 'learn by doing', triggers: ['learn'],
      program: { language: 'xiaotangyuan-skill-v1', steps: [{ op: 'call', atom: 'dst.try' }] } as SkillProgram,
    }
    const failed = await service.tryLearn(
      input, new Set(['dst.try']), async () => { throw new Error('动作顺序错误') }, new AbortController().signal,
    )
    expect(failed.result.success).toBe(false)
    expect(failed.learned).toBeUndefined()
    expect(store.get(input.gameId, input.skillId)).toBeUndefined()

    const succeeded = await service.tryLearn(
      input, new Set(['dst.try']), async () => ({ done: true }), new AbortController().signal,
    )
    expect(succeeded.result.success).toBe(true)
    expect(succeeded.learned?.version).toBe(1)
    expect(store.get(input.gameId, input.skillId)).toBeDefined()
  })

  it('records invalid v2 source as a failed learning attempt without saving a skill', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const store = new SkillStore({ enabled: true, directory, activeLimit: 5 })
    const service = new SkillService(store)
    const attempt = await service.tryLearnSource({
      gameId: 'dont-starve-together', skillId: 'dst.invalid', name: 'invalid',
      description: 'invalid source', triggers: ['invalid'],
      sourceCode: 'while (true) { await atom("dst.try", {}); }',
    }, new Set(['dst.try']), async () => ({}), new AbortController().signal)
    expect(attempt.result.success).toBe(false)
    expect(store.get('dont-starve-together', 'dst.invalid')).toBeUndefined()
    const document = JSON.parse(readFileSync(join(directory, 'skills-v2.json'), 'utf8')) as { learningAttempts: unknown[] }
    expect(document.learningAttempts).toHaveLength(1)
  })

  it('migrates the v1 document into skills-v2 without deleting the original', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const now = new Date().toISOString()
    writeFileSync(join(directory, 'skills-v1.json'), JSON.stringify({
      schemaVersion: 1,
      skills: [{
        id: 'dst.old', gameId: 'dont-starve-together', name: 'old', description: 'old',
        triggers: ['old'], version: 1, status: 'active',
        program: { language: 'xiaotangyuan-skill-v1', steps: [{ op: 'call', atom: 'dst.old' }] },
        createdAt: now, updatedAt: now, successCount: 1, failureCount: 0,
      }],
      history: [], learningAttempts: [],
    }))
    const store = new SkillStore({ enabled: true, directory, activeLimit: 5 })
    expect(store.get('dont-starve-together', 'dst.old')).toBeDefined()
    expect(existsSync(join(directory, 'skills-v1.json'))).toBe(true)
    const migrated = JSON.parse(readFileSync(join(directory, 'skills-v2.json'), 'utf8')) as { schemaVersion: number }
    expect(migrated.schemaVersion).toBe(2)
  })

  it('summarizes v2 skills without assuming the v1 steps field', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const store = new SkillStore({ enabled: true, directory, activeLimit: 5 })
    const skills = new SkillService(store)
    const learned = await skills.tryLearnSource({
      gameId: 'dont-starve-together', skillId: 'dst.v2-summary', name: 'v2 summary',
      description: 'exercise product summary compatibility', triggers: ['summary'],
      sourceCode: 'await atom("dst.try", {});',
    }, new Set(['dst.try']), async () => ({ ok: true }), new AbortController().signal)
    expect(learned.result.success).toBe(true)
    const snapshot = new XiaoTangYuanLearningService(new Context(), undefined, skills, undefined).snapshot('dont-starve-together')
    expect(snapshot.skills).toMatchObject([{ id: 'dst.v2-summary', stepCount: 1 }])
    expect(snapshot.skillAttempts).toMatchObject([{ success: true, stepCount: 1 }])
  })
})
