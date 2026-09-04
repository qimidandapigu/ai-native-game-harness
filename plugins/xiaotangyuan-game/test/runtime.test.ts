import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { gatewayReadyParams } from '../src/gateway/game-gateway.js'
import { readAdapterHello, readStateUpdate, readStateUpdateSaveId } from '../src/protocol/game.js'
import { buildPcm16Wav } from '../src/runtime/speech/wav.js'

describe('game runtime configuration', () => {
  it('defaults to mandatory multimodal and speech capabilities without embedding secrets', () => {
    const config = resolveConfig()
    expect(config.vision.enabled).toBe(true)
    expect(config.vision.maxWidth).toBe(1280)
    expect(config.speech.enabled).toBe(true)
    expect(config.speech.provider).toBe('auto')
    expect(config.speech.recognitionProvider).toBe('auto')
    expect(config.speech.synthesisProvider).toBe('auto')
    expect(config.speech.credentialRef).toBe('VOLCENGINE_API_KEY')
    expect(config.speech.asrFastResourceId).toBe('volc.bigasr.auc_turbo')
    expect(config.speech.asrStreamingResourceId).toBe('volc.bigasr.sauc.duration')
    expect(config.media.pushToTalkVirtualKey).toBe(0x77)
    expect(config.media.pushToTalkKey).toBe('v')
    expect(config.adapterProtocolUrl).toBe('ws://127.0.0.1:33245/adapter')
    expect(config.proactiveChat.enabled).toBe(true)
    expect(config.proactiveChat.intervalSeconds).toBe(180)
    expect(JSON.stringify(config)).not.toContain('apiKey')
  })

  it('allows recognition and synthesis capabilities to select different implementations', () => {
    const config = resolveConfig({
      speech: { recognitionProvider: 'local-asr', synthesisProvider: 'cloud-tts' },
    })
    expect(config.speech.recognitionProvider).toBe('local-asr')
    expect(config.speech.synthesisProvider).toBe('cloud-tts')
  })

  it('validates the printable macOS push-to-talk key', () => {
    expect(resolveConfig({ media: { pushToTalkKey: 'G' } }).media.pushToTalkKey).toBe('g')
    expect(() => resolveConfig({ media: { pushToTalkKey: 'F12' } })).toThrow('media.pushToTalkKey')
  })

  it('advertises a validated dynamic Adapter Protocol endpoint to game MODs', () => {
    const endpoint = resolveConfig({ adapterProtocolUrl: 'ws://localhost:45678/adapter' }).adapterProtocolUrl
    expect(gatewayReadyParams(endpoint)).toMatchObject({
      adapterProtocolUrl: endpoint,
      capabilities: expect.arrayContaining(['adapter.endpoint-discovery']),
    })
    expect(() => resolveConfig({ adapterProtocolUrl: 'https://127.0.0.1:45678/adapter' }))
      .toThrow('adapterProtocolUrl')
    expect(() => resolveConfig({ adapterProtocolUrl: 'ws://example.com:45678/adapter' }))
      .toThrow('adapterProtocolUrl')
  })

  it('rejects an unsafe screenshot width', () => {
    expect(() => resolveConfig({ vision: { maxWidth: 200 } })).toThrow('vision.maxWidth')
  })

  it('validates the shared proactive chat interval', () => {
    expect(resolveConfig({ proactiveChat: { intervalSeconds: 300 } }).proactiveChat.intervalSeconds).toBe(300)
    expect(() => resolveConfig({ proactiveChat: { intervalSeconds: 30 } })).toThrow('proactiveChat.intervalSeconds')
  })

  it('requires a complete, checksummed local Dont Starve installer override', () => {
    const archivePath = resolve('package.zip')
    expect(() => resolveConfig({
      installers: { dontStarve: { archivePath } },
    })).toThrow('archivePath, archiveVersion, and archiveSha256')
    expect(resolveConfig({
      installers: {
        dontStarve: {
          archivePath,
          archiveVersion: '0.2.17',
          archiveSha256: 'a'.repeat(64),
        },
      },
    }).installers.dontStarve.archiveVersion).toBe('0.2.17')
  })
})

describe('game protocol extensions', () => {
  it('accepts a process identity for foreground push-to-talk targeting', () => {
    expect(readAdapterHello({
      adapterId: 'test.adapter',
      gameId: 'test-game',
      version: '1.0.0',
      protocolVersion: '1.0',
      processId: 1234,
    }).processId).toBe(1234)
  })

  it('negotiates optional adapter capabilities without breaking protocol 1.0 clients', () => {
    expect(readAdapterHello({
      adapterId: 'test.adapter',
      gameId: 'test-game',
      version: '1.0.0',
      protocolVersion: '1.1',
      capabilities: ['assistant.text-stream'],
    }).capabilities).toEqual(['assistant.text-stream'])
    expect(() => readAdapterHello({
      adapterId: 'test.adapter',
      gameId: 'test-game',
      version: '1.0.0',
      protocolVersion: '1.1',
      capabilities: [1],
    })).toThrow('capabilities')
  })

  it('accepts a typed atom catalog so the model can generate executable skills', () => {
    const hello = readAdapterHello({
      adapterId: 'test.adapter', gameId: 'test-game', version: '1.0.0', protocolVersion: '1.1',
      atoms: [{ name: 'test.find_target', description: 'find target', parameters: '{}', returns: '{"targetId": number}' }],
    })
    expect(hello.atoms?.[0].returns).toContain('targetId')
  })

  it('accepts structured state updates', () => {
    expect(readStateUpdate({ observation: { player: { health: 80 } } })).toEqual({
      player: { health: 80 },
    })
  })

  it('accepts a sanitized save identity beside state without placing it in observation', () => {
    const update = { saveId: 'world-a1', observation: { player: { health: 80 } } }
    expect(readStateUpdateSaveId(update)).toBe('world-a1')
    expect(readStateUpdate(update)).not.toHaveProperty('saveId')
  })
})

describe('host audio format', () => {
  it('wraps PCM16 bytes in a valid mono WAV container', () => {
    const wav = buildPcm16Wav(new Uint8Array([0, 0, 1, 0]), 16_000, 1)
    expect(Buffer.from(wav.subarray(0, 4)).toString('ascii')).toBe('RIFF')
    expect(Buffer.from(wav.subarray(8, 12)).toString('ascii')).toBe('WAVE')
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(4)
  })
})
