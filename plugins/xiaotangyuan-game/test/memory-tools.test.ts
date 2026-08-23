import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryService } from '../src/runtime/memory/memory-service.js'
import { MemoryStore } from '../src/runtime/memory/memory-store.js'
import { registerMemoryTools } from '../src/tools/memory-tools.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('memory management tools', () => {
  it('registers view, correction and confirmed deletion backed by the isolated store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xiaotangyuan-memory-tools-'))
    directories.push(directory)
    const store = new MemoryStore({ enabled: true, autoLearn: true, directory, profileId: 'test', maxGameEntries: 50 })
    const active = { gameId: 'stardew-valley', saveId: 'farm-a' }
    store.remember(active, [{ kind: 'goal', subject: 'community', summary: '修复社区中心', importance: 4 }], 'turn-1')
    const tools: ToolDefinition[] = []
    const ctx = { tools: { register: (tool: ToolDefinition) => tools.push(tool) } } as unknown as Context
    const memory = { store, activeIdentities: () => [active] } as unknown as MemoryService
    registerMemoryTools(ctx, memory)

    expect(tools.map(tool => tool.name)).toEqual([
      'xiaotangyuan_memory_view', 'xiaotangyuan_memory_correct_shared', 'xiaotangyuan_memory_forget',
    ])
    const view = tools.find(tool => tool.name === 'xiaotangyuan_memory_view')!
    const report = await view.execute({}, {} as never) as { report: string }
    expect(report.report).toContain('修复社区中心')

    const correct = tools.find(tool => tool.name === 'xiaotangyuan_memory_correct_shared')!
    await correct.execute({ field: 'interests', value: '探索，经营', clear: false }, {} as never)
    expect(store.getSharedProfile().interests).toEqual(['探索', '经营'])

    const forget = tools.find(tool => tool.name === 'xiaotangyuan_memory_forget')!
    await forget.execute({ scope: 'current-save', confirmed: true }, {} as never)
    expect(store.listGameMemory(active)).toHaveLength(0)
    store.close()
  })
})
