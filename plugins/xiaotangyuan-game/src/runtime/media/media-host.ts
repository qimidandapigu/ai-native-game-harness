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
  processId?: number
  message: string
}

/** Platform-neutral media seam used by speech and vision. */
export interface MediaHost {
  start(): Promise<boolean>
  onEvent(listener: (event: MediaHostEvent) => void | Promise<void>): () => void
  configure(processIds: readonly number[]): void
  startRecording(processId: number): boolean
  stopRecording(processId: number): boolean
  play(audio: BinaryAsset, signal?: AbortSignal): Promise<void>
  startPcmPlayback(playbackId: string, sampleRate?: number): void
  appendPcmPlayback(playbackId: string, bytes: Uint8Array): void
  finishPcmPlayback(playbackId: string, signal?: AbortSignal): Promise<void>
  waitForPcmPosition(playbackId: string, byteOffset: number, signal?: AbortSignal): Promise<void>
  cancelPlayback(playbackId?: string): void
  captureProcessWindow(processId: number, maxWidth: number, signal: AbortSignal): Promise<BinaryAsset>
  close(): Promise<void>
}
