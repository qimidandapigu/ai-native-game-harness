import { describe, expect, it } from 'vitest'
import { deferPostTurnWork, emptyReplyFallback, formatGamePrompt, linkedWorkAcknowledgement, persistentGameSessionId } from '../src/runtime/agent/game-agent-session.js'

describe('persistent game sessions', () => {
  it('reuses one session for the same game save across Adapter reconnects', () => {
    const adapter = {
      adapterId: 'test.oni', gameId: 'oxygen-not-included', version: '1.0.0', protocolVersion: '1.1', saveId: 'colony-a',
    }
    expect(persistentGameSessionId(adapter)).toBe(persistentGameSessionId({ ...adapter, processId: 999 }))
  })

  it('isolates different saves and does not expose the raw save id', () => {
    const adapter = { adapterId: 'test.dst', gameId: 'dont-starve-together', version: '1.0.0', protocolVersion: '1.1' }
    const first = persistentGameSessionId(adapter, 'secret-save-a')
    const second = persistentGameSessionId(adapter, 'secret-save-b')
    expect(first).not.toBe(second)
    expect(first).not.toContain('secret-save-a')
  })

  it('uses a natural one-sentence fallback instead of exposing a missing model reply', () => {
    expect(emptyReplyFallback('帮我做一个 HTML')).toBe('好的，我收到啦，先让我看看。')
    expect(emptyReplyFallback('Create an HTML page')).toBe('Got it. Let me take a look.')
    expect(emptyReplyFallback('帮我做一个 HTML')).not.toContain('model returned no text reply')
  })

  it('uses a deterministic acknowledgement before inspecting linked work', () => {
    expect(linkedWorkAcknowledgement('HTML 做得怎么样了？')).toBe('好的，我帮你看看进度。')
    expect(linkedWorkAcknowledgement('How is it going?')).toBe('Sure. I will check the progress.')
  })

  it('defers work classification until the completed reply can be published', async () => {
    const events = ['reply-complete']
    deferPostTurnWork(() => events.push('work-classification'))
    events.push('reply-published')

    expect(events).toEqual(['reply-complete', 'reply-published'])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events).toEqual(['reply-complete', 'reply-published', 'work-classification'])
  })

  it('injects only the current linked work summary so progress questions keep context', () => {
    const prompt = formatGamePrompt(undefined, { text: 'HTML 做得怎么样了？' }, undefined, false, 'normal', {
      title: 'AI 影响游戏行业 HTML 汇报',
      status: '等待反馈',
    })

    expect(prompt).toContain('Current linked non-game work')
    expect(prompt).toContain('Title: AI 影响游戏行业 HTML 汇报')
    expect(prompt).toContain('Status: 等待反馈')
    expect(prompt).toContain('Do not invent progress')
  })

})
