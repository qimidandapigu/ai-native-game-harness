import type { AgentActionFeedback, AgentDriver, AgentEvent, AgentRequest } from '@ai-native-game-harness/harness-core'

export class MockAgentDriver implements AgentDriver {
  async *stream(request: AgentRequest): AsyncGenerator<AgentEvent, void, AgentActionFeedback> {
    const wantsCoin = /coin|金币|硬币|收集|捡/.test(request.message.toLowerCase())
    if (!wantsCoin) {
      const player = request.observation.state.player as { x: number; y: number; energy: number; coins: number }
      const answer = `我已连接 Mock Coin Garden。你在 (${player.x}, ${player.y})，体力 ${player.energy}，金币 ${player.coins}。可以让我去捡金币。`
      yield { type: 'analysis', text: '读取 Adapter 的权威 Observation，并回答当前状态。' }
      yield* this.#words(answer)
      yield { type: 'done', text: answer }
      return
    }

    yield { type: 'analysis', text: '目标是收集金币；先移动到 (2, 1)，再调用收集能力，并重新读取权威状态。' }
    const move = yield { type: 'action', capability: 'game.move', arguments: { x: 2, y: 1 } }
    if (!move.result.ok) {
      const answer = `移动失败：${move.result.error?.message ?? '未知错误'}`
      yield { type: 'done', text: answer }
      return
    }
    const collect = yield { type: 'action', capability: 'game.collect', arguments: {} }
    const answer = collect.result.ok ? '完成了：我移动到金币旁并收集了它。权威游戏状态已确认金币 +1。' : `收集失败：${collect.result.error?.message ?? '未知错误'}`
    yield* this.#words(answer)
    yield { type: 'done', text: answer }
  }

  async *#words(text: string): AsyncIterable<AgentEvent> {
    for (const chunk of text.match(/.{1,8}/gu) ?? [text]) yield { type: 'text-delta', text: chunk }
  }
}
