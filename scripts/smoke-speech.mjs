import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const credentialRef = process.argv[2] ?? 'VOLCENGINE_API_KEY'
const credentialsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
const document = await readFile(credentialsPath, 'utf8')

function yamlScalar(raw) {
  const value = raw.trim()
  if (value.startsWith('"')) return JSON.parse(value)
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  return value
}

let apiKey
for (const line of document.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/)
  if (match?.[1] === credentialRef) apiKey = yamlScalar(match[2])
}
if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error(`DSH 凭据 ${credentialRef} 未配置`)

function headers(resourceId, requestId) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
  }
}

function wavFromPcm(pcm) {
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24)
  wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  return wav
}

const ttsRequestId = randomUUID()
const tts = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
  method: 'POST',
  headers: headers('seed-tts-1.0', ttsRequestId),
  body: JSON.stringify({
    user: { uid: 'xiaotangyuan-smoke-test' },
    req_params: {
      text: '你好，这是小汤圆语音能力测试。',
      speaker: 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts',
      audio_params: { format: 'pcm', sample_rate: 24000 },
    },
  }),
})
const ttsBody = await tts.text()
if (!tts.ok) throw new Error(`TTS HTTP ${tts.status}`)
const pcmChunks = []
for (const raw of ttsBody.replaceAll(/}\s*{/g, '}\n{').split(/\r?\n/)) {
  if (raw.trim() === '') continue
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.data === 'string' && parsed.data !== '') pcmChunks.push(Buffer.from(parsed.data, 'base64'))
  } catch { }
}
const pcm = Buffer.concat(pcmChunks)
if (pcm.length === 0) throw new Error('TTS 未返回音频')
const wav = wavFromPcm(pcm)

const asrRequestId = randomUUID()
const submitHeaders = headers('volc.bigasr.auc', asrRequestId)
submitHeaders['X-Api-Sequence'] = '-1'
const submit = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', {
  method: 'POST',
  headers: submitHeaders,
  body: JSON.stringify({
    user: { uid: 'xiaotangyuan-smoke-test' },
    audio: { data: wav.toString('base64'), format: 'wav', codec: 'raw', rate: 24000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false },
  }),
})
if (!submit.ok) throw new Error(`ASR submit HTTP ${submit.status}`)

let transcript
for (let attempt = 0; attempt < 30; attempt += 1) {
  await delay(500)
  const query = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query', {
    method: 'POST',
    headers: headers('volc.bigasr.auc', asrRequestId),
    body: '{}',
  })
  const status = query.headers.get('X-Api-Status-Code') ?? ''
  const body = await query.text()
  if (status === '20000000') {
    transcript = JSON.parse(body).result?.text
    break
  }
  if (status !== '' && status !== '20000001') throw new Error(`ASR query status ${status}`)
}
if (typeof transcript !== 'string' || transcript.length === 0) throw new Error('ASR 未返回转写文本')

console.log(`TTS_OK=true WAV_BYTES=${wav.length}`)
console.log(`ASR_OK=true TRANSCRIPT=${transcript}`)
