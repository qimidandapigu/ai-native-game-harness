export function buildPcm16Wav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) header[offset + index] = value.charCodeAt(index)
  }

  const bitsPerSample = 16
  const blockAlign = channels * bitsPerSample / 8
  const byteRate = sampleRate * blockAlign
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  const wav = new Uint8Array(header.byteLength + pcm.byteLength)
  wav.set(header)
  wav.set(pcm, header.byteLength)
  return wav
}
