import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8')

describe('Stardew 0.8.2 selective integration', () => {
  it('passes the Desktop-assigned Adapter Protocol endpoint to the game gateway', () => {
    const desktop = read('apps/desktop/src/main.mjs')
    const plugin = read('plugins/xiaotangyuan-game/src/index.ts')
    expect(desktop).toContain("adapterProtocolUrl: 'ws://127.0.0.1:${adapterPort}/adapter'")
    expect(plugin).toContain('resolved.adapterProtocolUrl')
  })

  it('keeps production ability gates enabled and does not define a second main-story state', () => {
    const config = read('games/stardew-valley/adapter/ModConfig.cs')
    const growth = read('games/stardew-valley/adapter/Game/Narrative/NarrativeState.cs')
    const lessons = read('games/stardew-valley/adapter/Game/Narrative/QuestService.cs')
    expect(config).toContain('UnlockAllForTesting { get; set; } = false')
    expect(growth).toContain('CompanionGrowthState')
    expect(growth).not.toContain('ActiveStoryArc')
    expect(growth).not.toContain('StoryFlags')
    expect(growth).not.toContain('CompletedStoryNodes')
    expect(lessons).toContain('五个固定条目是技能教学与成长事件')
  })

  it('contains the standard Adapter handshake fix and real speech caption event', () => {
    const adapter = read('games/stardew-valley/adapter/Harness/AdapterProtocolClient.cs')
    const client = read('games/stardew-valley/adapter/GameAgentClient.cs')
    expect(adapter).toContain('HandleHostRequestAsync(activeSocket, root, timeout.Token)')
    expect(client).toContain('case "assistant.speech.phrase"')
    expect(client).toContain('AssistantSpeechCaptionChanged')
  })
})
