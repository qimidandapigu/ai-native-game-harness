import { randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import WebSocket, { type RawData } from 'ws'
import type { ResolvedConfig } from '../../config.js'
import type {
  BinaryAsset,
  SpeechRecognitionProvider,
  SpeechCapabilityProvider,
  SpeechSynthesisProvider,
  SpeechSynthesisRequest,
  StreamingRecognitionRequest,
  StreamingRecognitionSession,
} from '../providers/contracts.js'
import { buildPcm16Wav } from './wav.js'

const ASR_SUBMIT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
const ASR_QUERY_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'
const ASR_FLASH_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const ASR_STREAM_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'

function compact(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 300)}…`
}

async function responseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function packet(type: number, flags: number, serialization: number, compression: number, payload: Uint8Array, sequence?: number): Buffer {
  const body = compression === 1 ? gzipSync(payload) : Buffer.from(payload)
  const sequenceBytes = sequence === undefined ? 0 : 4
  const result = Buffer.allocUnsafe(4 + sequenceBytes + 4 + body.byteLength)
  result[0] = 0x11
  result[1] = (type << 4) | flags
  result[2] = (serialization << 4) | compression
  result[3] = 0
  let offset = 4
  if (sequence !== undefined) {
    result.writeInt32BE(sequence, offset)
    offset += 4
  }
  result.writeUInt32BE(body.byteLength, offset)
  result.set(body, offset + 4)
  return result
}

function parseAsrResponse(data: RawData): { text?: string, final: boolean, error?: string } {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
  if (bytes.byteLength < 8) return { final: false }
  const headerBytes = (bytes[0]! & 0x0f) * 4
  const type = bytes[1]! >> 4
  const flags = bytes[1]! & 0x0f
  const compression = bytes[2]! & 0x0f
  let offset = headerBytes
  let sequence: number | undefined
  if ((flags & 1) !== 0 && bytes.byteLength >= offset + 4) {
    sequence = bytes.readInt32BE(offset)
    offset += 4
  }
  if (type === 0x0f) {
    const code = bytes.readUInt32BE(offset)
    offset += 4
    const size = bytes.readUInt32BE(offset)
    const message = bytes.subarray(offset + 4, offset + 4 + size).toString('utf8')
    return { final: true, error: `流式语音识别失败 ${code}：${compact(message)}` }
  }
  if (bytes.byteLength < offset + 4) return { final: sequence !== undefined && sequence < 0 }
  const size = bytes.readUInt32BE(offset)
  let payload = bytes.subarray(offset + 4, offset + 4 + size)
  if (compression === 1 && payload.byteLength > 0) payload = gunzipSync(payload)
  if (payload.byteLength === 0) return { final: sequence !== undefined && sequence < 0 }
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as { result?: { text?: unknown }, message?: unknown }
    const text = typeof parsed.result?.text === 'string' ? parsed.result.text.trim() : undefined
    return { ...(text === undefined || text === '' ? {} : { text }), final: sequence !== undefined && sequence < 0 }
  } catch {
    return { final: sequence !== undefined && sequence < 0 }
  }
}

export class VolcengineStreamingRecognitionSession implements StreamingRecognitionSession {
  // The initial full-client request occupies the server-assigned sequence 1,
  // even though that packet doesn't carry an explicit sequence field.
  private sequence = 1
  private latest = ''
  private settled = false
  private readonly finalText: Promise<string>
  private resolveFinal!: (text: string) => void
  private rejectFinal!: (error: Error) => void

  constructor(
    private readonly socket: WebSocket,
    request: StreamingRecognitionRequest,
    signal: AbortSignal,
  ) {
    this.finalText = new Promise<string>((resolve, reject) => {
      this.resolveFinal = resolve
      this.rejectFinal = reject
    })
    // A server error can arrive before recording finishes and before finish()
    // has attached its await handler. Mark the promise handled immediately so
    // one failed voice turn can never become a process-level rejection.
    void this.finalText.catch(() => undefined)
    socket.on('message', data => {
      try {
        const response = parseAsrResponse(data)
        if (response.error !== undefined) return this.fail(new Error(response.error))
        if (response.text !== undefined && response.text !== this.latest) {
          this.latest = response.text
          request.onPartial?.(response.text)
        }
        if (response.final) this.complete()
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', error => this.fail(error))
    socket.on('close', () => {
      if (!this.settled) this.complete()
    })
    signal.addEventListener('abort', () => this.cancel(signal.reason), { once: true })
  }

  push(bytes: Uint8Array): void {
    if (this.settled || bytes.byteLength === 0 || this.socket.readyState !== WebSocket.OPEN) return
    this.sequence += 1
    this.socket.send(packet(0x02, 0x01, 0, 1, bytes, this.sequence))
  }

  async finish(): Promise<string> {
    if (!this.settled && this.socket.readyState === WebSocket.OPEN) {
      this.sequence += 1
      this.socket.send(packet(0x02, 0x03, 0, 1, new Uint8Array(), -this.sequence))
    }
    return await this.finalText
  }

  cancel(reason?: unknown): void {
    this.fail(reason instanceof Error ? reason : new Error('流式语音识别已取消'))
  }

  private complete(): void {
    if (this.settled) return
    this.settled = true
    this.socket.close()
    if (this.latest === '') this.rejectFinal(new Error('流式语音识别没有返回文本'))
    else this.resolveFinal(this.latest)
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.socket.close()
    this.rejectFinal(error)
  }
}

export class VolcengineSpeechProvider implements SpeechCapabilityProvider, SpeechRecognitionProvider, SpeechSynthesisProvider {
  readonly id = 'volcengine'
  private fastAsrAvailable: boolean | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig['speech'],
  ) {}

  async isAvailable(): Promise<boolean> {
    return (await this.ctx.credentials.describe(credentialRef(this.config.credentialRef))).configured
  }

  private async apiKey(): Promise<string> {
    const ref = credentialRef(this.config.credentialRef)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined) {
      throw new Error(`DSH 凭据 ${this.config.credentialRef} 尚未配置`)
    }
    return resolved.value.trim()
  }

  private headers(apiKey: string, resourceId: string, requestId: string): Headers {
    return new Headers({
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    })
  }

  async transcribe(audio: BinaryAsset, signal: AbortSignal): Promise<string> {
    if (audio.mediaType !== 'audio/wav') throw new Error(`语音识别需要 audio/wav，收到 ${audio.mediaType}`)
    const apiKey = await this.apiKey()
    if (this.fastAsrAvailable !== false) {
      try {
        const text = await this.transcribeFlash(audio, apiKey, signal)
        this.fastAsrAvailable = true
        return text
      } catch (error) {
        signal.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        this.fastAsrAvailable = /HTTP (400|401|403|404)/.test(message) ? false : undefined
        this.ctx.logger.warn('xiaotangyuan-game: 极速录音识别不可用，自动降级为标准识别')
        this.ctx.logger.warn(error)
      }
    }
    return await this.transcribeStandard(audio, apiKey, signal)
  }

  private async transcribeFlash(audio: BinaryAsset, apiKey: string, signal: AbortSignal): Promise<string> {
    const requestId = randomUUID()
    const headers = this.headers(apiKey, this.config.asrFastResourceId, requestId)
    headers.set('X-Api-Sequence', '-1')
    const response = await fetch(ASR_FLASH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user: { uid: 'xiaotangyuan-game-ai' },
        audio: { data: Buffer.from(audio.bytes).toString('base64') },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true },
      }),
      signal,
    })
    const body = await responseText(response)
    const status = response.headers.get('X-Api-Status-Code') ?? ''
    if (!response.ok || status !== '20000000') {
      throw new Error(`极速语音识别失败 HTTP ${response.status} ${status}：${compact(body)}`)
    }
    const parsed = JSON.parse(body) as { result?: { text?: unknown } }
    const text = parsed.result?.text
    if (typeof text !== 'string' || text.trim() === '') throw new Error('极速语音识别成功但没有返回文本')
    return text.trim()
  }

  private async transcribeStandard(audio: BinaryAsset, apiKey: string, signal: AbortSignal): Promise<string> {
    const requestId = randomUUID()
    const headers = this.headers(apiKey, this.config.asrResourceId, requestId)
    headers.set('X-Api-Sequence', '-1')

    const submit = await fetch(ASR_SUBMIT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user: { uid: 'xiaotangyuan-game-ai' },
        audio: {
          data: Buffer.from(audio.bytes).toString('base64'),
          format: 'wav',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1,
        },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
        },
      }),
      signal,
    })
    if (!submit.ok) {
      throw new Error(`语音识别提交失败 HTTP ${submit.status}：${compact(await responseText(submit))}`)
    }

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(500, undefined, { signal })
      const query = await fetch(ASR_QUERY_URL, {
        method: 'POST',
        headers: this.headers(apiKey, this.config.asrResourceId, requestId),
        body: '{}',
        signal,
      })
      const body = await responseText(query)
      const status = query.headers.get('X-Api-Status-Code') ?? ''
      if (status === '20000000') {
        const parsed = JSON.parse(body) as { result?: { text?: unknown } }
        const text = parsed.result?.text
        if (typeof text !== 'string' || text.trim() === '') throw new Error('语音识别成功但没有返回文本')
        return text.trim()
      }
      if (status === '20000001' || status === '') continue
      throw new Error(`语音识别查询失败 ${status}：${compact(body)}`)
    }
    throw new Error('语音识别等待结果超时')
  }

  async startStreaming(request: StreamingRecognitionRequest, signal: AbortSignal): Promise<StreamingRecognitionSession> {
    signal.throwIfAborted()
    const apiKey = await this.apiKey()
    const requestId = randomUUID()
    const socket = new WebSocket(ASR_STREAM_URL, {
      headers: Object.fromEntries(this.headers(apiKey, this.config.asrStreamingResourceId, requestId).entries()),
    })
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('流式语音识别已取消'))
      signal.addEventListener('abort', onAbort, { once: true })
      socket.once('open', () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
      socket.once('error', error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
    })
    const initial = Buffer.from(JSON.stringify({
      user: { uid: 'xiaotangyuan-game-ai' },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: request.format.sampleRate,
        bits: request.format.bitsPerSample,
        channel: request.format.channels,
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
        result_type: 'single',
      },
    }))
    socket.send(packet(0x01, 0, 1, 1, initial))
    return new VolcengineStreamingRecognitionSession(socket, request, signal)
  }

  async synthesize(request: SpeechSynthesisRequest, signal: AbortSignal): Promise<BinaryAsset> {
    const chunks: Uint8Array[] = []
    for await (const chunk of this.synthesizeStream(request, signal)) chunks.push(chunk)
    const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    if (bytes === 0) throw new Error('语音合成没有返回音频数据')
    const pcm = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      pcm.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes: buildPcm16Wav(pcm, 24000, 1), mediaType: 'audio/wav' }
  }

  async *synthesizeStream(request: SpeechSynthesisRequest, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const apiKey = await this.apiKey()
    const requestId = randomUUID()
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: this.headers(apiKey, this.config.ttsResourceId, requestId),
      body: JSON.stringify({
        user: { uid: 'xiaotangyuan-game-ai' },
        req_params: {
          text: request.text,
          speaker: request.voice ?? this.config.ttsVoice,
          audio_params: { format: 'pcm', sample_rate: 24000 },
        },
      }),
      signal,
    })
    if (!response.ok) throw new Error(`语音合成失败 HTTP ${response.status}：${compact(await responseText(response))}`)
    if (response.body === null) throw new Error('语音合成响应没有流式正文')
    const decoder = new TextDecoder()
    let buffered = ''
    let receivedAudio = false
    for await (const bytes of response.body) {
      buffered += decoder.decode(bytes, { stream: true })
      const records = buffered.replaceAll(/}\s*{/g, '}\n{').split(/\r?\n/)
      buffered = records.pop() ?? ''
      for (const raw of records) {
        if (raw.trim() === '') continue
        const parsed = JSON.parse(raw) as { data?: unknown }
        if (typeof parsed.data === 'string' && parsed.data !== '') {
          receivedAudio = true
          yield new Uint8Array(Buffer.from(parsed.data, 'base64'))
        }
      }
    }
    buffered += decoder.decode()
    if (buffered.trim() !== '') {
      const parsed = JSON.parse(buffered) as { data?: unknown }
      if (typeof parsed.data === 'string' && parsed.data !== '') {
        receivedAudio = true
        yield new Uint8Array(Buffer.from(parsed.data, 'base64'))
      }
    }
    if (!receivedAudio) throw new Error('语音合成没有返回音频数据')
  }
}
