import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

const gatewayDeclarations = [
  ['desktop profile', 'integrations/xiaotangyuan/desktop.patch.yml', /port:\s*33145/],
  ['integration profile', 'integrations/xiaotangyuan/smoke.patch.yml', /port:\s*33145/],
  ['runtime profile', 'runtime/dsh-profile/xiaotangyuan.patch.yml', /port:\s*33145/],
  ['plugin profile', 'plugins/xiaotangyuan-game/cordis.patch.yml', /port:\s*33145/],
  ['Stardew adapter', 'games/stardew-valley/adapter/ModConfig.cs', /GatewayUrl[^\n]*33145/],
  ['Don\'t Starve adapter', 'games/dont-starve-together/src/dont_starve_ai_mod/config.py', /HARNESS_GATEWAY_URL[^\n]*33145/],
  ['Oxygen Not Included adapter', 'games/oxygen-not-included/adapter/src/config.ts', /config\.port\s*\?\?\s*33145/],
] as const

describe('game Gateway endpoint', () => {
  it.each(gatewayDeclarations)('%s uses the shared port', (_name, path, pattern) => {
    expect(readFileSync(resolve(root, path), 'utf8')).toMatch(pattern)
  })

  it('does not fall back to the ordinary DSH port in game-edition configuration', () => {
    for (const [, path] of gatewayDeclarations) {
      expect(readFileSync(resolve(root, path), 'utf8')).not.toContain('32145')
    }
  })
})
