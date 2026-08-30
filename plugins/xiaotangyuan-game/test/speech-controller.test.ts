import { describe, expect, it, vi } from 'vitest'
import { SpeechController } from '../src/runtime/speech/speech-controller.js'

function controllerWith(stream: (signal: AbortSignal) => AsyncIterable<Uint8Array>) {
  const provider = {
    id: 'test-tts',
    isAvailable: async () => true,
    synthesize: vi.fn(),
    synthesizeStream: (_request: unknown, signal: AbortSignal) => stream(signal),
  }
  const media = {
    startPcmPlayback: vi.fn(), appendPcmPlayback: vi.fn(), finishPcmPlayback: vi.fn(async () => undefined),
    waitForPcmPosition: vi.fn(async () => undefined), cancelPlayback: vi.fn(),
  }
  const handler = {
    speechStarted: vi.fn(),
    speechPhraseStarted: vi.fn(),
    speechFinished: vi.fn(),
  }
  const capabilities = { resolve: async () => provider }
  const controller = new SpeechController(
    { logger: { warn: vi.fn() } } as never,
    {} as never,
    media as never,
    handler as never,
    capabilities as never,
  )
  return { controller, media, handler }
}

describe('streaming speech exactly-once fallback', () => {
  it('does not replay the whole answer after partial streaming audio was already played', async () => {
    const { controller, media } = controllerWith(async function* () {
      yield new Uint8Array([1, 2, 3])
      throw new Error('stream interrupted')
    })
    await controller.appendSpeechDelta(42, 'turn-1', '第一句。')
    await expect(controller.finishSpeechReply(42, 'turn-1', '第一句。')).resolves.toBe(true)
    expect(media.appendPcmPlayback).toHaveBeenCalledTimes(1)
  })

  it('allows the full-answer fallback when streaming failed before any audio arrived', async () => {
    const { controller, media } = controllerWith(async function* () {
      await Promise.resolve()
      throw new Error('stream unavailable')
    })
    await controller.appendSpeechDelta(42, 'turn-2', '第一句。')
    await expect(controller.finishSpeechReply(42, 'turn-2', '第一句。')).resolves.toBe(false)
    expect(media.appendPcmPlayback).not.toHaveBeenCalled()
  })

  it('does not report streamed speech complete until buffered playback has drained', async () => {
    let finishPlayback!: () => void
    const { controller, media } = controllerWith(async function* () {
      yield new Uint8Array([1, 2, 3])
    })
    media.finishPcmPlayback.mockImplementation(() => new Promise<void>(resolve => { finishPlayback = resolve }))
    await controller.appendSpeechDelta(42, 'turn-3', '第一句。')
    let settled = false
    const result = controller.finishSpeechReply(42, 'turn-3', '第一句。').finally(() => { settled = true })
    await vi.waitFor(() => expect(media.finishPcmPlayback).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    finishPlayback()
    await expect(result).resolves.toBe(true)
  })

  it('publishes voice captions one completed phrase at that phrase playback position', async () => {
    const { controller, media, handler } = controllerWith(async function* () {
      yield new Uint8Array([1, 2, 3, 4])
    })
    await controller.appendSpeechDelta(42, 'turn-4', '第一句。第二句。')
    await expect(controller.finishSpeechReply(42, 'turn-4', '第一句。第二句。')).resolves.toBe(true)
    expect(media.waitForPcmPosition).toHaveBeenNthCalledWith(1, expect.any(String), 0, expect.any(AbortSignal))
    expect(media.waitForPcmPosition).toHaveBeenNthCalledWith(2, expect.any(String), 4, expect.any(AbortSignal))
    expect(handler.speechPhraseStarted).toHaveBeenNthCalledWith(1, 42, 'turn-4', '第一句。', '第一句。')
    expect(handler.speechPhraseStarted).toHaveBeenNthCalledWith(2, 42, 'turn-4', '第二句。', '第一句。第二句。')
  })
})
