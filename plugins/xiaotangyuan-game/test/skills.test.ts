import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillRuntime, validateSkillProgram } from '../src/runtime/skills/skill-runtime.js'
import { SkillStore } from '../src/runtime/skills/skill-store.js'
import { SkillService } from '../src/runtime/skills/skill-service.js'
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

  it('rejects undeclared atoms before executing code', () => {
    expect(() => validateSkillProgram({
      language: 'xiaotangyuan-skill-v1',
      steps: [{ op: 'call', atom: 'dst.delete_world' }],
    }, new Set(['dst.find']))).toThrow('游戏未声明原子能力')
  })

  it('keeps at most ten active skills and archives instead of deleting', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xty-skills-'))
    temporary.push(directory)
    const store = new SkillStore({ enabled: true, directory, activeLimit: 10 })
    const now = new Date().toISOString()
    for (let index = 0; index < 11; index += 1) {
      const record: SkillRecord = {
        id: `dst.test-${index}`, gameId: 'dont-starve-together', name: `test ${index}`,
        description: 'test', triggers: ['test'], version: 1, status: 'active',
        program: { language: 'xiaotangyuan-skill-v1', steps: [{ op: 'call', atom: 'dst.test' }] },
        createdAt: now, updatedAt: now, successCount: 0, failureCount: 0,
      }
      store.upsert(record)
    }
    expect(store.list('dont-starve-together')).toHaveLength(10)
    expect(store.get('dont-starve-together', 'dst.test-10')).toBeDefined()
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
})
