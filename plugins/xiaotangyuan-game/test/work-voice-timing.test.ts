import { describe, expect, it, vi } from 'vitest'
import { GameGateway, playPresentedSpeech, playerFacingVoiceFailure } from '../src/gateway/game-gateway.js'

describe('voice and post-turn work timing', () => {
  it('never exposes internal fetch errors to the game', () => {
    expect(playerFacingVoiceFailure('fetch failed')).toBe('网络刚才有点不稳，我没能回答出来。请再问我一次吧。')
    expect(playerFacingVoiceFailure('request timeout')).toBe('这次等得太久了，我先停下来。请再问我一次吧。')
  })

  it('keeps a work bubble held until its spoken notification has finished', async () => {
    const events: string[] = []
    let releaseSpeech!: () => void
    const speaking = new Promise<void>(resolve => { releaseSpeech = resolve })
    const playback = playPresentedSpeech(
      async () => { events.push('audio-started'); await speaking; events.push('audio-finished') },
      () => events.push('bubble-held'),
      () => events.push('bubble-released'),
    )

    await Promise.resolve()
    expect(events).toEqual(['bubble-held', 'audio-started'])
    releaseSpeech()
    await playback
    expect(events).toEqual(['bubble-held', 'audio-started', 'audio-finished', 'bubble-released'])
  })

  it('starts deferred work recognition while the final speech queue is still draining', async () => {
    const events: string[] = []
    let releaseSpeech!: () => void
    const speechQueue = new Promise<void>(resolve => { releaseSpeech = resolve })
    let recognitionStarted = false
    const connection = {
      latestSaveId: 'save-a',
      latestObservation: undefined,
      speechQueue,
      adapter: { gameId: 'test-game' },
      session: {
        async ask() {
          events.push('answer-complete')
          queueMicrotask(() => {
            recognitionStarted = true
            events.push('work-recognition-started')
          })
          return { reply: '正常回答已经完成。', sessionId: 'companion-session', interactionId: 'turn-1' }
        },
      },
    }
    const finishSpeechReply = vi.fn(async () => {
      events.push('speech-finished')
      return true
    })
    const notify = vi.fn(() => events.push('caption-presented'))
    const finishTextStream = vi.fn(() => events.push('caption-finished'))
    const gateway = {
      connectionForProcess: () => connection,
      markInteraction: () => undefined,
      finishSpeechReply,
      notify,
      finishTextStream,
      speechFinished: () => undefined,
    }
    const respond = GameGateway.prototype.respond as unknown as (
      this: typeof gateway,
      processId: number,
      transcript: string,
      signal: AbortSignal,
    ) => Promise<unknown>

    let responseSettled = false
    const response = respond.call(gateway, 42, '帮我做个汇报', new AbortController().signal)
      .finally(() => { responseSettled = true })
    await Promise.resolve()
    await Promise.resolve()

    expect(recognitionStarted).toBe(true)
    expect(responseSettled).toBe(false)
    expect(finishSpeechReply).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(connection, 'assistant.present', {
      text: '正常回答已经完成。',
      source: 'voice',
    })
    expect(finishTextStream).toHaveBeenCalledWith(connection, 'turn-1', '正常回答已经完成。', 'voice')
    expect(events).toEqual([
      'answer-complete',
      'work-recognition-started',
      'caption-presented',
      'caption-finished',
    ])

    releaseSpeech()
    await response
    expect(finishSpeechReply).toHaveBeenCalledOnce()
    expect(events).toEqual([
      'answer-complete',
      'work-recognition-started',
      'caption-presented',
      'caption-finished',
      'speech-finished',
    ])
  })

  it('cancels the active agent turn when a new voice recording barges in', async () => {
    const controller = new AbortController()
    let rejectAsk!: (error: unknown) => void
    const cancel = vi.fn(() => rejectAsk(controller.signal.reason))
    const connection = {
      latestSaveId: 'save-a',
      latestObservation: undefined,
      speechQueue: Promise.resolve(),
      adapter: { gameId: 'test-game' },
      session: {
        ask: vi.fn(() => new Promise<never>((_resolve, reject) => { rejectAsk = reject })),
        cancel,
      },
    }
    const gateway = {
      connectionForProcess: () => connection,
      markInteraction: () => undefined,
      finishSpeechReply: vi.fn(),
      notify: vi.fn(),
      finishTextStream: vi.fn(),
      speechFinished: vi.fn(),
    }
    const respond = GameGateway.prototype.respond as unknown as (
      this: typeof gateway,
      processId: number,
      transcript: string,
      signal: AbortSignal,
    ) => Promise<unknown>

    const response = respond.call(gateway, 42, '第一句', controller.signal)
    await vi.waitFor(() => expect(connection.session.ask).toHaveBeenCalledOnce())
    controller.abort(new Error('玩家开始了新的语音输入'))

    await expect(response).rejects.toThrow('玩家开始了新的语音输入')
    expect(cancel).toHaveBeenCalledOnce()
    expect(gateway.finishSpeechReply).not.toHaveBeenCalled()
    expect(gateway.notify).not.toHaveBeenCalled()
  })
})
