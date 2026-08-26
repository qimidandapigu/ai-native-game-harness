import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Oxygen Not Included voice wiring', () => {
  it('uses Q in the game Bridge and forwards explicit voice lifecycle events', () => {
    const runtime = read('games/oxygen-not-included/bridge/src/DoubaoAIRuntime.cs')
    const bridge = read('games/oxygen-not-included/bridge/src/Harness/OniHarnessBridge.cs')

    expect(runtime).toMatch(/Input\.GetKeyDown\(KeyCode\.Q\)/)
    expect(runtime).toMatch(/Input\.GetKeyUp\(KeyCode\.Q\)/)
    expect(runtime).toContain('_bridge.StartVoice()')
    expect(runtime).toContain('_bridge.StopVoice()')
    expect(bridge).toContain('Enqueue("voice.start"')
    expect(bridge).toContain('Enqueue("voice.stop"')
  })

  it('shows the voice lifecycle beside the floating companion', () => {
    const runtime = read('games/oxygen-not-included/bridge/src/DoubaoAIRuntime.cs')

    expect(runtime).toContain('_floatingStatus = _status')
    expect(runtime).toContain('"聆听中…"')
    expect(runtime).toContain('"思考中…"')
    expect(runtime).toContain('"回答中…"')
    expect(runtime).toMatch(/showStatus\s*\?\s*_floatingStatus/)
    expect(runtime).toContain('_floatingStatus = string.Empty')
  })

  it('bundles the ONI Adapter into the desktop profile', () => {
    const desktop = read('apps/desktop/src/main.mjs')
    const prepare = read('scripts/prepare-desktop-runtime.ps1')

    expect(desktop).toContain("'@qimidandapigu/oni-adapter'")
    expect(prepare).toContain('$oniArchivePath')
    expect(prepare).toContain('runtime ONI Adapter installation failed')
  })
})
