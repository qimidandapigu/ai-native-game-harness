import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { keepRecentConversationTurns, pruneHistoricalImages } from '../src/runtime/agent/context-history.js'

function image(bytes: number) {
  return {
    type: 'image' as const,
    attachment: {
      attachmentId: `test-${bytes}` as never,
      mediaType: 'image/png' as const,
      bytes,
      width: 1280,
      height: 720,
    },
  }
}

describe('game conversation context history', () => {
  it('keeps only two completed turns so the next request has three player turns total', () => {
    const session = Session.create(SessionId('game-context-three-turn-test'))
    for (let turn = 1; turn <= 5; turn += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `玩家第${turn}轮` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn,
        step: 0,
        message: { content: [{ type: 'text', text: `回答第${turn}轮` }] },
      }, { surfaceOp: 'append' })
    }

    expect(keepRecentConversationTurns(session, 2)).toEqual({ turns: 3, messages: 6 })
    const visible = session.deriveMessages().flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
    expect(visible).toEqual([
      '[Earlier companion conversation omitted from the model context to keep replies fast.]',
      '玩家第4轮', '回答第4轮', '玩家第5轮', '回答第5轮',
    ])
    expect(session.events.some(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === '玩家第1轮'))).toBe(true)
    expect(keepRecentConversationTurns(session, 2)).toEqual({ turns: 0, messages: 0 })
  })

  it('keeps historical text but removes screenshots from future model input', () => {
    const session = Session.create(SessionId('game-context-test'))
    const original = session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: '第一轮玩家消息' },
        image(400_000),
        image(300_000),
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const result = pruneHistoricalImages(session)

    expect(result).toEqual({ messages: 1, images: 2, bytes: 700_000 })
    expect(session.deriveMessages()).toHaveLength(1)
    expect(session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: '第一轮玩家消息' }])
    expect(session.events[original.seq]?.data).toMatchObject({
      content: [{ type: 'text' }, { type: 'image' }, { type: 'image' }],
    })
    expect(session.surface.nodes).not.toContain(original.seq)
  })

  it('is idempotent after image-bearing surface messages have been replaced', () => {
    const session = Session.create(SessionId('game-context-idempotent-test'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '保留我' }, image(123_456)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(pruneHistoricalImages(session).images).toBe(1)
    expect(pruneHistoricalImages(session)).toEqual({ messages: 0, images: 0, bytes: 0 })
    expect(session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: '保留我' }])
  })
})
