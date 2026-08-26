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
    startPcmPlayback: vi.fn(), appendPcmPlayback: vi.fn(), finishPcmPlayback: vi.fn(), cancelPlayback: vi.fn(),
  }
  const capabilities = { resolve: async () => provider }
  const controller = new SpeechController(
    { logger: { warn: vi.fn() } } as never,
    {} as never,
    media as never,
    {} as never,
    capabilities as never,
  )
  return { controller, media }
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
})
