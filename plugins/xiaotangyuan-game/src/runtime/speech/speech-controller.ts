import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { ResolvedConfig } from '../../config.js'
import { CapabilityRegistry } from '../capabilities.js'
import type { MediaHost, MediaHostEvent } from '../media/media-host.js'
import type { SpeechRecognitionProvider, SpeechSynthesisProvider, StreamingRecognitionSession } from '../providers/contracts.js'
import { publishProductDiagnostic } from '../diagnostics.js'

export interface VoiceInteractionHandler {
  recordingStarted(processId: number): void
  recordingStopped(processId: number): void
  speechStarted(processId: number, interactionId: string): void
  speechPhraseStarted(processId: number, interactionId: string, phrase: string, text: string): void
  speechFinished(processId: number, interactionId: string): void
  respond(processId: number, transcript: string, signal: AbortSignal): Promise<{
    reply: string
    speechPlayed: boolean
    sessionId: string
    interactionId: string
    gameId: string
  }>
  failed(processId: number, message: string): void
}

interface LiveRecording {
  controller: AbortController
  session?: Promise<StreamingRecognitionSession>
  buffered: Uint8Array[]
  streamingFailed?: Error
}

interface SpeechOutput {
  processId: number
  interactionId: string
  controller: AbortController
  buffer: string
  spokenText: string
  playbackId: string
  chain: Promise<void>
  provider: SpeechSynthesisProvider
  started: boolean
  audioAppended: boolean
  queuedAudioBytes: number
  captionText: string
  captionChain: Promise<void>
  speechAnnounced: boolean
}

export class SpeechController {
  private readonly active = new Set<number>()
  private readonly recordings = new Map<string, LiveRecording>()
  private readonly interactions = new Map<number, AbortController>()
  private readonly speechOutputs = new Map<number, SpeechOutput>()
  private targets: readonly number[] = []
  private disposeListener?: () => void

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig['speech'],
    private readonly media: MediaHost,
    private readonly handler: VoiceInteractionHandler,
    private readonly capabilities: CapabilityRegistry,
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled) return
    const [recognition, synthesis] = await Promise.all([
      this.selectRecognitionProvider(),
      this.selectSynthesisProvider(),
    ])
    if (recognition === undefined) this.ctx.logger.warn('xiaotangyuan-game: 当前没有已配置的语音识别能力')
    if (synthesis === undefined) this.ctx.logger.warn('xiaotangyuan-game: 当前没有已配置的语音合成能力')
    this.disposeListener = this.media.onEvent(event => this.onMediaEvent(event))
    if (await this.media.start()) this.media.configure(this.targets)
  }

  private async selectRecognitionProvider(): Promise<SpeechRecognitionProvider | undefined> {
    return await this.capabilities.resolve<SpeechRecognitionProvider>(
      'speech.transcribe',
      this.config.recognitionProvider,
    )
  }

  private async selectSynthesisProvider(): Promise<SpeechSynthesisProvider | undefined> {
    return await this.capabilities.resolve<SpeechSynthesisProvider>(
      'speech.synthesize',
      this.config.synthesisProvider,
    )
  }

  updateTargets(processIds: readonly number[]): void {
    this.targets = [...processIds]
    this.media.configure(processIds)
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    const provider = await this.selectSynthesisProvider()
    if (provider === undefined) throw new Error('没有可用的语音合成 Provider，请先在 DSH 中绑定相应凭据')
    if (provider.synthesizeStream !== undefined) {
      const playbackId = randomUUID()
      this.media.startPcmPlayback(playbackId)
      const onAbort = (): void => this.media.cancelPlayback(playbackId)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        for await (const chunk of provider.synthesizeStream({ text }, signal)) {
          this.media.appendPcmPlayback(playbackId, chunk)
        }
        await this.media.finishPcmPlayback(playbackId, signal)
        return
      } catch (error) {
        this.media.cancelPlayback(playbackId)
        throw error
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
    const audio = await provider.synthesize({ text }, signal)
    await this.media.play(audio, signal)
  }

  async appendSpeechDelta(processId: number, interactionId: string, delta: string): Promise<void> {
    let output = this.speechOutputs.get(processId)
    if (output?.interactionId !== interactionId) {
      output?.controller.abort(new Error('新的语音回复已开始'))
      if (output !== undefined) this.media.cancelPlayback(output.playbackId)
      const provider = await this.selectSynthesisProvider()
      if (provider === undefined || provider.synthesizeStream === undefined) return
      output = {
        processId,
        interactionId,
        controller: new AbortController(),
        buffer: '',
        spokenText: '',
        playbackId: randomUUID(),
        chain: Promise.resolve(),
        provider,
        started: false,
        audioAppended: false,
        queuedAudioBytes: 0,
        captionText: '',
        captionChain: Promise.resolve(),
        speechAnnounced: false,
      }
      this.speechOutputs.set(processId, output)
    }
    output.buffer += delta
    this.queueReadyPhrases(output, false)
  }

  async finishSpeechReply(processId: number, interactionId: string, finalText: string): Promise<boolean> {
    const output = this.speechOutputs.get(processId)
    if (output?.interactionId !== interactionId) return false
    if (output.spokenText === '' && output.buffer === '') output.buffer = finalText
    else if (finalText.startsWith(output.spokenText + output.buffer)) {
      output.buffer += finalText.slice((output.spokenText + output.buffer).length)
    }
    this.queueReadyPhrases(output, true)
    try {
      await output.chain
      await output.captionChain
      if (output.started) await this.media.finishPcmPlayback(output.playbackId, output.controller.signal)
      return output.started
    } catch (error) {
      this.media.cancelPlayback(output.playbackId)
      this.ctx.logger.warn(output.audioAppended
        ? 'xiaotangyuan-game: 增量 TTS 中途失败；为避免重复播放，不再整段重播'
        : 'xiaotangyuan-game: 增量 TTS 在播放前失败，将尝试完整回复兼容路径')
      this.ctx.logger.warn(error)
      return output.audioAppended
    } finally {
      this.speechOutputs.delete(processId)
    }
  }

  private queueReadyPhrases(output: SpeechOutput, flush: boolean): void {
    const phrases: string[] = []
    while (output.buffer !== '') {
      const boundary = output.buffer.search(/[。！？!?\n]/)
      if (boundary >= 0) {
        phrases.push(output.buffer.slice(0, boundary + 1))
        output.buffer = output.buffer.slice(boundary + 1)
        continue
      }
      if (!flush && output.buffer.length < 36) break
      if (flush) {
        phrases.push(output.buffer)
        output.buffer = ''
        break
      }
      const splitAt = Math.max(output.buffer.lastIndexOf('，', 36), output.buffer.lastIndexOf(',', 36), output.buffer.lastIndexOf(' ', 36))
      const length = splitAt >= 12 ? splitAt + 1 : 36
      phrases.push(output.buffer.slice(0, length))
      output.buffer = output.buffer.slice(length)
    }
    for (const phrase of phrases.map(value => value.trim()).filter(value => value !== '')) {
      output.spokenText += phrase
      output.chain = output.chain.then(async () => {
        output.controller.signal.throwIfAborted()
        let captionScheduled = false
        for await (const chunk of output.provider.synthesizeStream!({ text: phrase }, output.controller.signal)) {
          if (chunk.byteLength === 0) continue
          if (!output.started) {
            this.media.startPcmPlayback(output.playbackId)
            output.started = true
          }
          if (!captionScheduled) {
            captionScheduled = true
            const phraseStartByte = output.queuedAudioBytes
            output.captionChain = output.captionChain.then(async () => {
              await this.media.waitForPcmPosition(output.playbackId, phraseStartByte, output.controller.signal)
              if (!output.speechAnnounced) {
                output.speechAnnounced = true
                this.handler.speechStarted(output.processId, output.interactionId)
              }
              output.captionText += phrase
              this.handler.speechPhraseStarted(output.processId, output.interactionId, phrase, output.captionText)
            })
          }
          if (chunk.byteLength > 0) output.audioAppended = true
          this.media.appendPcmPlayback(output.playbackId, chunk)
          output.queuedAudioBytes += chunk.byteLength
        }
      })
    }
  }

  private async onMediaEvent(event: MediaHostEvent): Promise<void> {
    if (event.type === 'error') {
      this.ctx.logger.warn('xiaotangyuan-game media: %s', event.message)
      if (event.processId !== undefined && Number.isSafeInteger(event.processId) && event.processId > 0) {
        this.handler.failed(event.processId, event.message)
      }
      return
    }
    if (event.type === 'recording.started') {
      this.interactions.get(event.processId)?.abort(new Error('玩家开始了新的语音输入'))
      this.interactions.delete(event.processId)
      const output = this.speechOutputs.get(event.processId)
      output?.controller.abort(new Error('玩家打断了语音回复'))
      if (output !== undefined) this.speechOutputs.delete(event.processId)
      this.media.cancelPlayback()
      this.handler.recordingStarted(event.processId)
      const controller = new AbortController()
      const live: LiveRecording = { controller, buffered: [] }
      this.recordings.set(event.recordingId, live)
      const provider = await this.selectRecognitionProvider()
      if (provider?.startStreaming !== undefined) {
        live.session = provider.startStreaming({
          format: { sampleRate: event.sampleRate, bitsPerSample: event.bitsPerSample, channels: event.channels },
        }, controller.signal).then(session => {
          for (const chunk of live.buffered) session.push(chunk)
          live.buffered.length = 0
          return session
        }).catch(error => {
          live.streamingFailed = error instanceof Error ? error : new Error(String(error))
          throw live.streamingFailed
        })
        void live.session.catch(() => undefined)
      }
      return
    }
    if (event.type === 'recording.chunk') {
      const live = this.recordings.get(event.recordingId)
      if (live === undefined) return
      const chunk = new Uint8Array(Buffer.from(event.audioBase64, 'base64'))
      if (live.session === undefined) live.buffered.push(chunk)
      else void live.session.then(session => session.push(chunk)).catch(() => live.buffered.push(chunk))
      return
    }
    if (event.type === 'recording.stopped') {
      this.handler.recordingStopped(event.processId)
      return
    }
    if (event.type === 'recording.cancelled') {
      const live = this.recordings.get(event.recordingId)
      this.recordings.delete(event.recordingId)
      live?.controller.abort(new Error(event.message))
      this.handler.failed(event.processId, event.message)
      return
    }
    if (event.type !== 'recording.completed') return

    this.active.add(event.processId)
    const interactionStarted = performance.now()
    const live = this.recordings.get(event.recordingId)
    this.recordings.delete(event.recordingId)
    const controller = live?.controller ?? new AbortController()
    this.interactions.set(event.processId, controller)
    const timeout = setTimeout(() => controller.abort(new Error('语音交互超时')), 120_000)
    let diagnosticIdentity: { sessionId: string, interactionId: string, gameId: string } | undefined
    try {
      const provider = await this.selectRecognitionProvider()
      if (provider === undefined) throw new Error('没有可用的语音识别能力，请先在 DSH 中绑定相应凭据')
      const asrStarted = performance.now()
      let transcript: string
      if (live?.session !== undefined && live.streamingFailed === undefined) {
        try {
          transcript = await (await live.session).finish()
        } catch (error) {
          this.ctx.logger.warn('xiaotangyuan-game: 流式语音识别失败，自动降级为录音文件识别')
          this.ctx.logger.warn(error)
          transcript = await provider.transcribe({
            bytes: new Uint8Array(Buffer.from(event.audioBase64, 'base64')),
            mediaType: event.mediaType,
          }, controller.signal)
        }
      } else {
        transcript = await provider.transcribe({
          bytes: new Uint8Array(Buffer.from(event.audioBase64, 'base64')),
          mediaType: event.mediaType,
        }, controller.signal)
      }
      const asrFinished = performance.now()
      const response = await this.handler.respond(event.processId, transcript, controller.signal)
      diagnosticIdentity = response
      const agentFinished = performance.now()
      if (!response.speechPlayed) {
        this.handler.speechStarted(event.processId, response.interactionId)
        try {
          await this.speak(response.reply, controller.signal)
        } finally {
          this.handler.speechFinished(event.processId, response.interactionId)
        }
      }
      const ttsFinished = performance.now()
      this.ctx.logger.info(
        `xiaotangyuan voice latency processId=${event.processId} asrMs=${Math.round(asrFinished - asrStarted)} agentMs=${Math.round(agentFinished - asrFinished)} ttsMs=${Math.round(ttsFinished - agentFinished)} totalMs=${Math.round(ttsFinished - interactionStarted)}`,
      )
      publishProductDiagnostic({
        kind: 'voice.latency',
        sessionId: response.sessionId,
        gameId: response.gameId,
        interactionId: response.interactionId,
        detail: {
          source: 'voice',
          processId: event.processId,
          asrMs: Math.round(asrFinished - asrStarted),
          agentMs: Math.round(agentFinished - asrFinished),
          ttsMs: Math.round(ttsFinished - agentFinished),
          totalMs: Math.round(ttsFinished - interactionStarted),
          speechStreamed: response.speechPlayed,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted && controller.signal.reason instanceof Error
        && controller.signal.reason.message === '玩家开始了新的语音输入') {
        publishProductDiagnostic({
          kind: 'voice.cancelled',
          ...(diagnosticIdentity ?? {}),
          detail: {
            source: 'voice',
            processId: event.processId,
            reason: 'barge-in',
            elapsedMs: Math.round(performance.now() - interactionStarted),
          },
        })
        return
      }
      publishProductDiagnostic({
        kind: 'voice.failed',
        ...(diagnosticIdentity ?? {}),
        detail: {
          source: 'voice',
          processId: event.processId,
          stage: diagnosticIdentity === undefined ? 'asr-or-agent' : 'tts',
          errorName: error instanceof Error ? error.name : 'Error',
          timeout: /timeout|超时/i.test(message),
          elapsedMs: Math.round(performance.now() - interactionStarted),
        },
      })
      this.handler.failed(event.processId, message)
    } finally {
      clearTimeout(timeout)
      this.active.delete(event.processId)
      if (this.interactions.get(event.processId) === controller) this.interactions.delete(event.processId)
    }
  }

  async close(): Promise<void> {
    this.disposeListener?.()
    this.disposeListener = undefined
    for (const live of this.recordings.values()) live.controller.abort(new Error('语音运行时正在关闭'))
    for (const interaction of this.interactions.values()) interaction.abort(new Error('语音运行时正在关闭'))
    for (const output of this.speechOutputs.values()) output.controller.abort(new Error('语音运行时正在关闭'))
    this.recordings.clear()
    this.interactions.clear()
    this.speechOutputs.clear()
    await this.media.close()
  }
}
