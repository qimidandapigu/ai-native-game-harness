interface Env {
  XTY_FEEDBACK_CLIENTS_JSON: string
  GITHUB_TOKEN: string
  GITHUB_OWNER: string
  GITHUB_REPO: string
}
interface FeedbackReport {
  schemaVersion: 1
  reportId: string
  submittedAt: string
  source: {
    product: 'dsh-xiaotangyuan-game'
    pluginVersion: string
    clientId: string
  }
  category: 'feature_request'
  title: string
  summary: string
  playerQuote: string
  gameId: string
  adapterId: string
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const recentNonces = new Map<string, number>()

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function sha256(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))
}

function equalConstantTime(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

function readClients(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('XTY_FEEDBACK_CLIENTS_JSON must be an object')
  }
  const clients: Record<string, string> = {}
  for (const [clientId, secret] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(clientId) || typeof secret !== 'string' || secret.length < 32) {
      throw new Error('XTY_FEEDBACK_CLIENTS_JSON contains an invalid client or a secret shorter than 32 characters')
    }
    clients[clientId] = secret
  }
  return clients
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim()
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

function reserveNonce(clientId: string, nonce: string, now: number): boolean {
  for (const [key, expiresAt] of recentNonces) {
    if (expiresAt <= now) recentNonces.delete(key)
  }
  const key = `${clientId}:${nonce}`
  if (recentNonces.has(key)) return false
  recentNonces.set(key, now + MAX_CLOCK_SKEW_MS)
  return true
}

export async function verifyOfficialRequest(
  request: Request,
  body: string,
  clients: Record<string, string>,
  now = Date.now(),
): Promise<string> {
  const clientId = requiredHeader(request, 'x-xty-client-id')
  const timestamp = requiredHeader(request, 'x-xty-timestamp')
  const nonce = requiredHeader(request, 'x-xty-nonce')
  const signature = requiredHeader(request, 'x-xty-signature')
  const secret = clients[clientId]
  if (secret === undefined) throw new Error('unknown official client')
  const timestampNumber = Number(timestamp)
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > MAX_CLOCK_SKEW_MS) {
    throw new Error('request timestamp is outside the allowed window')
  }
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(nonce)) throw new Error('invalid nonce')
  const canonical = `${clientId}\n${timestamp}\n${nonce}\n${await sha256(body)}`
  const expected = await hmac(secret, canonical)
  if (!equalConstantTime(signature, expected)) throw new Error('invalid official client signature')
  if (!reserveNonce(clientId, nonce, now)) throw new Error('replayed request')
  return clientId
}

function requiredText(record: Record<string, unknown>, key: string, maxLength = 4_000): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`${key} must be a non-empty string no longer than ${maxLength} characters`)
  }
  return value.trim()
}

export function readReport(value: unknown): FeedbackReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('report must be an object')
  const report = value as Record<string, unknown>
  const sourceValue = report.source
  if (typeof sourceValue !== 'object' || sourceValue === null || Array.isArray(sourceValue)) {
    throw new Error('source must be an object')
  }
  const source = sourceValue as Record<string, unknown>
  if (report.schemaVersion !== 1 || report.category !== 'feature_request') {
    throw new Error('unsupported feedback schema or category')
  }
  if (source.product !== 'dsh-xiaotangyuan-game') throw new Error('unsupported feedback product')
  const reportId = requiredText(report, 'reportId', 80)
  if (!/^[a-f0-9-]{36}$/i.test(reportId)) throw new Error('reportId must be a UUID')
  const submittedAt = requiredText(report, 'submittedAt', 80)
  if (!Number.isFinite(Date.parse(submittedAt))) throw new Error('submittedAt must be an ISO timestamp')
  return {
    schemaVersion: 1,
    reportId,
    submittedAt,
    source: {
      product: 'dsh-xiaotangyuan-game',
      pluginVersion: requiredText(source, 'pluginVersion', 80),
      clientId: requiredText(source, 'clientId', 80),
    },
    category: 'feature_request',
    title: requiredText(report, 'title', 300),
    summary: requiredText(report, 'summary'),
    playerQuote: requiredText(report, 'playerQuote'),
    gameId: requiredText(report, 'gameId', 120),
    adapterId: requiredText(report, 'adapterId', 180),
  }
}

function issueBody(report: FeedbackReport): string {
  return [
    `<!-- xty-report-id:${report.reportId} -->`,
    '## 玩家原话',
    report.playerQuote,
    '',
    '## AI 整理',
    report.summary,
    '',
    '## 环境',
    `- 游戏：${report.gameId}`,
    `- Adapter：${report.adapterId}`,
    `- 插件版本：${report.source.pluginVersion}`,
    `- 官方客户端：${report.source.clientId}`,
    `- 提交时间：${report.submittedAt}`,
    `- 反馈编号：${report.reportId}`,
  ].join('\n')
}

async function createGitHubIssue(report: FeedbackReport, env: Env): Promise<{ number: number }> {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/issues`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'xiaotangyuan-feedback-receiver',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      title: `[功能建议] ${report.title}`,
      body: issueBody(report),
      labels: ['player-feedback', 'feature-request'],
    }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`GitHub issue creation failed HTTP ${response.status}: ${body.slice(0, 500)}`)
  const parsed = JSON.parse(body) as { number?: unknown }
  if (!Number.isSafeInteger(parsed.number)) throw new Error('GitHub returned no issue number')
  return { number: parsed.number as number }
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return json(413, { error: 'feedback body is too large' })
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return json(413, { error: 'feedback body is too large' })

  let clientId: string
  try {
    clientId = await verifyOfficialRequest(request, body, readClients(env.XTY_FEEDBACK_CLIENTS_JSON))
  } catch (error) {
    return json(401, { error: error instanceof Error ? error.message : 'official client verification failed' })
  }

  let report: FeedbackReport
  try {
    report = readReport(JSON.parse(body))
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'invalid feedback report' })
  }
  if (report.source.clientId !== clientId) return json(401, { error: 'signed client does not match report source' })

  try {
    const issue = await createGitHubIssue(report, env)
    return json(201, { accepted: true, reportId: report.reportId, issueNumber: issue.number })
  } catch (error) {
    console.error(error)
    return json(502, { error: 'feedback storage failed' })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') return json(200, { ok: true })
    if (request.method === 'POST' && url.pathname === '/v1/feedback') return handleFeedback(request, env)
    return json(404, { error: 'not found' })
  },
}
