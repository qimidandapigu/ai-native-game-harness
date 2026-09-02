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
    const notify = vi.fn((_connection: unknown, method: string) => {
      if (method === 'assistant.present') events.push('caption-presented')
    })
    const finishTextStream = vi.fn(() => events.push('caption-finished'))
    const gateway = {
      connectionForProcess: () => connection,
      markInteraction: () => undefined,
      schedulePostReplyAction: () => events.push('game-action-scheduled'),
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
      'game-action-scheduled',
    ])

    releaseSpeech()
    await response
    expect(finishSpeechReply).toHaveBeenCalledOnce()
    expect(events).toEqual([
      'answer-complete',
      'work-recognition-started',
      'caption-presented',
      'caption-finished',
      'game-action-scheduled',
      'speech-finished',
    ])
  })

  it('publishes the reply before a game action while post-turn work still runs independently', async () => {
    const events: string[] = []
    const connection = {
      latestSaveId: 'save-a',
      latestObservation: { cursor: { cell: 321 } },
      speechQueue: Promise.resolve(),
      streamingInteractions: new Set<string>(),
      postReplyAction: undefined as AbortController | undefined,
      adapter: {
        gameId: 'oxygen-not-included',
        atoms: [{ name: 'oni_companion_absorb_water', description: 'absorb', parameters: '{}', returns: '{}' }],
        voiceCommands: [{ atom: 'oni_companion_absorb_water', phrases: ['吸水'] }],
      },
      session: {
        async ask() {
          setImmediate(() => events.push('post-turn-work'))
          return { reply: '好，我马上吸水。', sessionId: 'companion-session', interactionId: 'turn-action' }
        },
      },
    }
    const internals = GameGateway.prototype as unknown as {
      schedulePostReplyAction: (connection: unknown, transcript: string, reply: string, interactionId: string) => void
      runPostReplyAction: (connection: unknown, atom: string, interactionId: string, controller: AbortController) => Promise<void>
    }
    const gateway = {
      ctx: { logger: { warn: vi.fn() } },
      connectionForProcess: () => connection,
      markInteraction: () => undefined,
      notify: (_connection: unknown, method: string, params: { status?: string; atom?: string }) => {
        events.push(`${method}${params.status === undefined ? '' : `:${params.status}`}${params.atom === undefined ? '' : `:${params.atom}`}`)
      },
      finishTextStream: () => events.push('assistant.text.done'),
      finishSpeechReply: async () => { events.push('speech.finish'); return true },
      speechFinished: () => undefined,
      callAdapterAtom: async (_connection: unknown, atom: string) => {
        events.push(`game.atom.execute:${atom}`)
        return { success: true, reply: '吸水成功' }
      },
      schedulePostReplyAction: internals.schedulePostReplyAction,
      runPostReplyAction: internals.runPostReplyAction,
    }
    const respond = GameGateway.prototype.respond as unknown as (
      this: typeof gateway,
      processId: number,
      transcript: string,
      signal: AbortSignal,
    ) => Promise<unknown>

    await respond.call(gateway, 42, '帮我吸水一下', new AbortController().signal)
    await new Promise<void>(resolve => setImmediate(resolve))

    const replyIndex = events.indexOf('assistant.present')
    const actionIndex = events.indexOf('game.atom.execute:oni_companion_absorb_water')
    expect(replyIndex).toBeGreaterThanOrEqual(0)
    expect(actionIndex).toBeGreaterThan(replyIndex)
    expect(events).toContain('assistant.action.result:oni_companion_absorb_water')
    expect(events).toContain('post-turn-work')
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
      schedulePostReplyAction: vi.fn(),
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
    expect(gateway.notify).toHaveBeenCalledOnce()
    expect(gateway.notify).toHaveBeenCalledWith(connection, 'assistant.status', {
      status: 'thinking',
      transcript: '第一句',
    })
  })
})
