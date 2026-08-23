import { describe, expect, it } from 'vitest'
import { CapabilityRegistry, missingRequiredCapabilities, REQUIRED_ENGINE_CAPABILITIES } from '../src/runtime/capabilities.js'

describe('required engine capabilities', () => {
  it('requires voice and multimodal capabilities independently of vendors', () => {
    expect(REQUIRED_ENGINE_CAPABILITIES).toEqual([
      'vision.observe',
      'speech.transcribe',
      'speech.synthesize',
      'media.capture.microphone',
      'media.play.audio',
    ])
  })

  it('reports capabilities that have no ready provider', () => {
    expect(missingRequiredCapabilities([
      { capability: 'vision.observe', ready: true, provider: 'any-vision-provider' },
      { capability: 'media.capture.microphone', ready: true, provider: 'windows-media-host' },
    ])).toEqual([
      'speech.transcribe',
      'speech.synthesize',
      'media.play.audio',
    ])
  })

  it('routes each capability independently instead of coupling ASR and TTS vendors', async () => {
    const registry = new CapabilityRegistry()
    registry.register('speech.transcribe', { id: 'asr-a', isAvailable: async () => true })
    registry.register('speech.synthesize', { id: 'tts-b', isAvailable: async () => true })

    await expect(registry.describe('speech.transcribe')).resolves.toEqual({
      capability: 'speech.transcribe',
      ready: true,
      provider: 'asr-a',
    })
    await expect(registry.describe('speech.synthesize')).resolves.toEqual({
      capability: 'speech.synthesize',
      ready: true,
      provider: 'tts-b',
    })
  })

  it('falls back past unavailable providers in auto mode and respects an explicit selection', async () => {
    const registry = new CapabilityRegistry()
    registry.register('speech.transcribe', { id: 'offline', isAvailable: async () => false })
    registry.register('speech.transcribe', { id: 'ready', isAvailable: async () => true })

    await expect(registry.describe('speech.transcribe')).resolves.toMatchObject({ ready: true, provider: 'ready' })
    await expect(registry.describe('speech.transcribe', 'offline')).resolves.toMatchObject({
      ready: false,
      reason: 'preferred-provider-unavailable',
    })
  })
})
