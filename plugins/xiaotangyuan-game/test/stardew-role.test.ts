import { describe, expect, it } from 'vitest'
import { classifyStardewCommands, deterministicRoutingFor, roleInstructionsFor } from '../src/runtime/agent/game-role.js'

const adapter = {
  adapterId: 'qimidandapigu.StardewAgent',
  gameId: 'stardew-valley',
  version: '0.7.0',
  protocolVersion: '1.1',
}

describe('Stardew Harness role and deterministic routing', () => {
  it.each([
    ['帮我砍树', ['stardew.clear_debris']],
    ['砍一下树', ['stardew.clear_debris']],
    ['把地浇水然后收菜', ['stardew.water_all', 'stardew.harvest_all']],
    ['帮我起飞', ['stardew.flight_takeoff']],
    ['送我回家睡觉', ['stardew.rescue_home']],
  ])('maps %s to standard Harness capabilities', (text, expected) => {
    expect(classifyStardewCommands(text)).toEqual(expected)
  })

  it.each(['不要砍树', '我刚砍树', '之前已经浇水了', "don't harvest"])('does not route negated or historical text: %s', (text) => {
    expect(classifyStardewCommands(text)).toEqual([])
  })

  it('adds role and routing instructions only for Stardew', () => {
    expect(roleInstructionsFor(adapter)).toContain('小汤圆')
    expect(deterministicRoutingFor(adapter, '帮我砍树')).toContain('stardew.clear_debris')
    expect(roleInstructionsFor({ ...adapter, gameId: 'other-game' })).toBeUndefined()
  })
})
