import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

describe('product model binding', () => {
  it('ships the two Zhipu model routes needed by the game edition', () => {
    const patch = readFileSync(resolve(root, 'integrations/xiaotangyuan/desktop.patch.yml'), 'utf8')

    expect(patch).toMatch(/id: llm-pi-ai[\s\S]*?zhipu:[\s\S]*?apiKeyEnv: ZHIPU_API_KEY/)
    expect(patch).toMatch(/id: glm-5\.2[\s\S]*?contextWindow: 1048576[\s\S]*?max: max/)
    expect(patch).toMatch(/id: glm-5v-turbo[\s\S]*?contextWindow: 204800[\s\S]*?- image/)
  })

  it('pins Harness and Worker work to GLM-5.2 max reasoning', () => {
    const patch = readFileSync(resolve(root, 'integrations/xiaotangyuan/desktop.patch.yml'), 'utf8')

    expect(patch).toMatch(/id: agent-default-model[\s\S]*?provider: zhipu[\s\S]*?model: glm-5\.2[\s\S]*?reasoningEffort: max/)
    expect(patch).toMatch(/id: work-orchestrator[\s\S]*?provider: zhipu[\s\S]*?model: glm-5\.2[\s\S]*?reasoningEffort: max/)
  })

  it('pins game text, voice and screenshot turns to GLM-5V-Turbo', () => {
    const patch = readFileSync(resolve(root, 'integrations/xiaotangyuan/desktop.patch.yml'), 'utf8')

    expect(patch).toMatch(/id: xiaotangyuan-game[\s\S]*?vision:[\s\S]*?provider: zhipu[\s\S]*?model: glm-5v-turbo/)
  })
})
