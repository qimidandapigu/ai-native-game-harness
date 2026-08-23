import type { CapabilityProvider } from '../capabilities.js'

export interface BinaryAsset {
  bytes: Uint8Array
  mediaType: string
}

export interface MultimodalRequest {
  prompt: string
  images: readonly BinaryAsset[]
}

export interface MultimodalProvider extends CapabilityProvider {
  analyze(request: MultimodalRequest, signal: AbortSignal): Promise<string>
}

export interface SpeechRecognitionProvider extends CapabilityProvider {
  transcribe(audio: BinaryAsset, signal: AbortSignal): Promise<string>
  startStreaming?(request: StreamingRecognitionRequest, signal: AbortSignal): Promise<StreamingRecognitionSession>
}

export interface PcmFormat {
  sampleRate: number
  bitsPerSample: 16
  channels: 1
}

export interface StreamingRecognitionRequest {
  format: PcmFormat
  onPartial?: (text: string) => void
}

export interface StreamingRecognitionSession {
  push(bytes: Uint8Array): void
  finish(): Promise<string>
  cancel(reason?: unknown): void
}

export interface SpeechSynthesisRequest {
  text: string
  voice?: string
}

export interface SpeechSynthesisProvider extends CapabilityProvider {
  synthesize(request: SpeechSynthesisRequest, signal: AbortSignal): Promise<BinaryAsset>
  synthesizeStream?(request: SpeechSynthesisRequest, signal: AbortSignal): AsyncIterable<Uint8Array>
}

export interface SpeechCapabilityProvider extends SpeechRecognitionProvider, SpeechSynthesisProvider {}

export interface HostMediaService {
  captureMicrophone(signal: AbortSignal): Promise<BinaryAsset>
  captureForegroundWindow(signal: AbortSignal): Promise<BinaryAsset>
  playAudio(audio: BinaryAsset, signal: AbortSignal): Promise<void>
}
