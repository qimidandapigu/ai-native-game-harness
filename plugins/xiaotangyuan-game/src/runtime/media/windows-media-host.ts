import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../../config.js'
import type { BinaryAsset } from '../providers/contracts.js'

export type MediaHostEvent = {
  type: 'ready'
  version: string
} | {
  type: 'recording.started'
  processId: number
  recordingId: string
  sampleRate: number
  bitsPerSample: 16
  channels: 1
} | {
  type: 'recording.chunk'
  processId: number
  recordingId: string
  sequence: number
  audioBase64: string
} | {
  type: 'recording.stopped'
  processId: number
  recordingId: string
} | {
  type: 'recording.completed'
  processId: number
  recordingId: string
  mediaType: string
  audioBase64: string
} | {
  type: 'recording.cancelled'
  processId: number
  recordingId: string
  message: string
} | {
  type: 'playback.finished'
  playbackId: string
} | {
  type: 'capture.completed'
  requestId: string
  processId: number
  mediaType: string
  imageBase64: string
  width: number
  height: number
} | {
  type: 'error'
  requestId?: string | null
  message: string
}

interface PendingCapture {
  resolve: (asset: BinaryAsset) => void
  reject: (error: Error) => void
  cleanup: () => void
}

interface PendingPlayback {
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
}

interface PlaybackEstimate {
  startedAt: number
  durationMs: number
}

export class WindowsMediaHost {
  private child?: ChildProcessWithoutNullStreams
  private readonly listeners = new Set<(event: MediaHostEvent) => void | Promise<void>>()
  private readonly pendingCaptures = new Map<string, PendingCapture>()
  private readonly pendingPlaybacks = new Map<string, PendingPlayback>()
  private readonly playbackEstimates = new Map<string, PlaybackEstimate>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig['media'],
  ) {}

  private executablePath(): string {
    return this.config.executablePath
      ?? fileURLToPath(new URL('../../../media/windows-x64/XtyMediaHost.exe', import.meta.url))
  }

  async start(): Promise<boolean> {
    if (!this.config.enabled || process.platform !== 'win32') return false
    const executable = this.executablePath()
    try {
      await access(executable)
    } catch {
      this.ctx.logger.warn('xiaotangyuan-game: Windows 媒体服务不存在：%s', executable)
      return false
    }

    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.onLine(line))
    child.stderr.on('data', data => {
      const message = data.toString().trim()
      if (message !== '') this.ctx.logger.warn('xiaotangyuan-game media: %s', message)
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      this.rejectPendingCaptures(new Error('Windows 媒体服务已退出'))
      this.rejectPendingPlaybacks(new Error('Windows 媒体服务已退出'))
      if (code !== 0 && code !== null) {
        this.ctx.logger.warn('xiaotangyuan-game: 媒体服务退出，code=%s signal=%s', code, signal)
      }
    })
    return true
  }

  onEvent(listener: (event: MediaHostEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private onLine(line: string): void {
    let event: MediaHostEvent
    try {
      event = JSON.parse(line) as MediaHostEvent
    } catch {
      this.ctx.logger.warn('xiaotangyuan-game: 媒体服务返回了无效 JSON')
      return
    }
    if (event.type === 'capture.completed') {
      const pending = this.pendingCaptures.get(event.requestId)
      if (pending !== undefined) {
        this.pendingCaptures.delete(event.requestId)
        pending.cleanup()
        pending.resolve({
          bytes: new Uint8Array(Buffer.from(event.imageBase64, 'base64')),
          mediaType: event.mediaType,
        })
      }
      return
    }
    if (event.type === 'playback.finished') {
      const pending = this.pendingPlaybacks.get(event.playbackId)
      if (pending !== undefined) {
        this.pendingPlaybacks.delete(event.playbackId)
        this.playbackEstimates.delete(event.playbackId)
        pending.cleanup()
        pending.resolve()
      }
      return
    }
    if (event.type === 'error' && event.requestId != null) {
      const pending = this.pendingCaptures.get(event.requestId)
      if (pending !== undefined) {
        this.pendingCaptures.delete(event.requestId)
        pending.cleanup()
        pending.reject(new Error(event.message))
      }
      return
    }
    for (const listener of this.listeners) {
      Promise.resolve(listener(event)).catch(error => {
        this.ctx.logger.warn('xiaotangyuan-game: 媒体事件处理失败')
        this.ctx.logger.warn(error)
      })
    }
  }

  private send(method: string, params: unknown): boolean {
    if (this.child?.stdin.writable !== true) return false
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
    return true
  }

  configure(processIds: readonly number[]): void {
    this.send('configure', {
      processIds: [...processIds],
      pushToTalkVirtualKey: this.config.pushToTalkVirtualKey,
    })
  }

  startRecording(processId: number): boolean {
    if (!Number.isInteger(processId) || processId <= 0) throw new Error('游戏 Adapter 没有提供有效的进程 ID')
    return this.send('recording.start', { processId })
  }

  stopRecording(processId: number): boolean {
    if (!Number.isInteger(processId) || processId <= 0) throw new Error('游戏 Adapter 没有提供有效的进程 ID')
    return this.send('recording.stop', { processId })
  }

  async play(audio: BinaryAsset, signal?: AbortSignal): Promise<void> {
    if (audio.mediaType !== 'audio/wav') throw new Error(`Windows 媒体服务需要 audio/wav，收到 ${audio.mediaType}`)
    const playbackId = randomUUID()
    const durationMs = wavDurationMilliseconds(audio.bytes)
    this.playbackEstimates.set(playbackId, { startedAt: Date.now(), durationMs })
    const completed = this.waitForPlayback(playbackId, durationMs + 350, signal)
    if (!this.send('play', { playbackId, audioBase64: Buffer.from(audio.bytes).toString('base64') })) {
      this.rejectPlayback(playbackId, new Error('Windows 媒体服务尚未启动'))
    }
    await completed
  }

  startPcmPlayback(playbackId: string, sampleRate = 24_000): void {
    this.playbackEstimates.set(playbackId, { startedAt: Date.now(), durationMs: 0 })
    this.send('play.start', { playbackId, sampleRate, bitsPerSample: 16, channels: 1 })
  }

  appendPcmPlayback(playbackId: string, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    const estimate = this.playbackEstimates.get(playbackId)
    if (estimate !== undefined) estimate.durationMs += bytes.byteLength / (24_000 * 2) * 1_000
    this.send('play.chunk', { playbackId, audioBase64: Buffer.from(bytes).toString('base64') })
  }

  async finishPcmPlayback(playbackId: string, signal?: AbortSignal): Promise<void> {
    const estimate = this.playbackEstimates.get(playbackId)
    const remainingMs = estimate === undefined
      ? 350
      : Math.max(0, estimate.durationMs - (Date.now() - estimate.startedAt)) + 350
    const completed = this.waitForPlayback(playbackId, remainingMs, signal)
    if (!this.send('play.end', { playbackId })) {
      this.rejectPlayback(playbackId, new Error('Windows 媒体服务尚未启动'))
    }
    await completed
  }

  async waitForPcmPosition(playbackId: string, byteOffset: number, signal?: AbortSignal): Promise<void> {
    const estimate = this.playbackEstimates.get(playbackId)
    if (estimate === undefined || byteOffset <= 0) return
    const targetMs = byteOffset / (24_000 * 2) * 1_000
    const remainingMs = targetMs - (Date.now() - estimate.startedAt)
    if (remainingMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('语音播放已取消'))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, remainingMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
    })
  }

  cancelPlayback(playbackId?: string): void {
    this.send('play.cancel', playbackId === undefined ? {} : { playbackId })
    const error = new Error('语音播放已取消')
    if (playbackId === undefined) this.rejectPendingPlaybacks(error)
    else this.rejectPlayback(playbackId, error)
  }

  private waitForPlayback(playbackId: string, fallbackMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.rejectPlayback(playbackId, signal?.reason instanceof Error ? signal.reason : new Error('语音播放已取消'))
      }
      const timer = setTimeout(() => {
        const pending = this.pendingPlaybacks.get(playbackId)
        if (pending === undefined) return
        this.pendingPlaybacks.delete(playbackId)
        this.playbackEstimates.delete(playbackId)
        pending.cleanup()
        pending.resolve()
      }, Math.max(50, fallbackMs))
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pendingPlaybacks.set(playbackId, { resolve, reject, cleanup })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
    })
  }

  private rejectPlayback(playbackId: string, error: Error): void {
    const pending = this.pendingPlaybacks.get(playbackId)
    this.playbackEstimates.delete(playbackId)
    if (pending === undefined) return
    this.pendingPlaybacks.delete(playbackId)
    pending.cleanup()
    pending.reject(error)
  }

  async captureProcessWindow(processId: number, maxWidth: number, signal: AbortSignal): Promise<BinaryAsset> {
    if (!Number.isInteger(processId) || processId <= 0) throw new Error('游戏 Adapter 没有提供有效的进程 ID')
    signal.throwIfAborted()
    const requestId = randomUUID()
    return await new Promise<BinaryAsset>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.pendingCaptures.get(requestId)
        if (pending === undefined) return
        this.pendingCaptures.delete(requestId)
        pending.cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new Error('游戏窗口截图已取消'))
      }
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      this.pendingCaptures.set(requestId, { resolve, reject, cleanup })
      signal.addEventListener('abort', onAbort, { once: true })
      if (!this.send('capture', { requestId, processId, maxWidth })) {
        this.pendingCaptures.delete(requestId)
        cleanup()
        reject(new Error('Windows 媒体服务尚未启动'))
      }
    })
  }

  private rejectPendingCaptures(error: Error): void {
    for (const pending of this.pendingCaptures.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pendingCaptures.clear()
  }

  private rejectPendingPlaybacks(error: Error): void {
    for (const playbackId of [...this.pendingPlaybacks.keys()]) this.rejectPlayback(playbackId, error)
    this.playbackEstimates.clear()
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.rejectPendingCaptures(new Error('Windows 媒体服务正在关闭'))
    this.rejectPendingPlaybacks(new Error('Windows 媒体服务正在关闭'))
    if (child === undefined) return
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ method: 'shutdown', params: {} })}\n`)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 2_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function wavDurationMilliseconds(bytes: Uint8Array): number {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.byteLength < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0
  let offset = 12
  let bytesPerSecond = 0
  let dataBytes = 0
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const contentOffset = offset + 8
    if (chunkId === 'fmt ' && chunkSize >= 16 && contentOffset + 12 <= buffer.byteLength) {
      bytesPerSecond = buffer.readUInt32LE(contentOffset + 8)
    } else if (chunkId === 'data') {
      dataBytes = Math.min(chunkSize, Math.max(0, buffer.byteLength - contentOffset))
      break
    }
    offset = contentOffset + chunkSize + (chunkSize % 2)
  }
  return bytesPerSecond > 0 ? dataBytes / bytesPerSecond * 1_000 : 0
}
