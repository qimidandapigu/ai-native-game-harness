import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResolvedConfig } from '../../config.js'
import type {
  FeedbackReceipt,
  FeedbackReport,
  FeedbackSubmission,
  FeedbackSubmitter,
} from './contracts.js'

const PLUGIN_VERSION = '0.5.2'
const MAX_FIELD_LENGTH = 4_000

function requireCompactText(value: string, field: string): string {
  const result = value.trim()
  if (result === '') throw new Error(`${field} must not be empty`)
  if (result.length > MAX_FIELD_LENGTH) throw new Error(`${field} exceeds ${MAX_FIELD_LENGTH} characters`)
  return result
}
function digestBody(body: string): string {
  return createHash('sha256').update(body).digest('base64url')
}

export function signFeedbackRequest(
  secret: string,
  clientId: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  const canonical = `${clientId}\n${timestamp}\n${nonce}\n${digestBody(body)}`
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

function readReceipt(value: unknown, expectedReportId: string): FeedbackReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('反馈服务返回了无效响应')
  }
  const source = value as Record<string, unknown>
  if (source.accepted !== true || source.reportId !== expectedReportId) {
    throw new Error('反馈服务没有确认本次报告')
  }
  if (source.issueNumber !== undefined && !Number.isSafeInteger(source.issueNumber)) {
    throw new Error('反馈服务返回了无效 Issue 编号')
  }
  if (source.issueUrl !== undefined && typeof source.issueUrl !== 'string') {
    throw new Error('反馈服务返回了无效 Issue 地址')
  }
  return {
    accepted: true,
    reportId: expectedReportId,
    ...(source.issueNumber === undefined ? {} : { issueNumber: source.issueNumber as number }),
    ...(source.issueUrl === undefined ? {} : { issueUrl: source.issueUrl }),
  }
}

export class SignedFeedbackClient implements FeedbackSubmitter {
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig['feedback'],
  ) {}

  private async secret(): Promise<string> {
    const ref = credentialRef(this.config.credentialRef)
    const resolved = await this.ctx.credentials.resolve(ref)
    const secret = resolved?.value.trim() ?? ''
    if (secret === '') {
      throw new Error(`DSH 凭据 ${this.config.credentialRef} 尚未配置，无法验证官方 Harness`)
    }
    return secret
  }

  async submit(submission: FeedbackSubmission, signal: AbortSignal): Promise<FeedbackReceipt> {
    if (!this.config.enabled || this.config.endpoint === undefined) {
      throw new Error('自动反馈尚未配置接收地址')
    }

    const report: FeedbackReport = {
      schemaVersion: 1,
      reportId: randomUUID(),
      submittedAt: new Date().toISOString(),
      source: {
        product: 'dsh-xiaotangyuan-game',
        pluginVersion: PLUGIN_VERSION,
        clientId: this.config.clientId,
      },
      category: submission.category,
      title: requireCompactText(submission.title, 'title'),
      summary: requireCompactText(submission.summary, 'summary'),
      playerQuote: requireCompactText(submission.playerQuote, 'playerQuote'),
      gameId: requireCompactText(submission.gameId, 'gameId'),
      adapterId: requireCompactText(submission.adapterId, 'adapterId'),
    }
    const body = JSON.stringify(report)
    const timestamp = String(Date.now())
    const nonce = randomUUID()
    const secret = await this.secret()
    const signature = signFeedbackRequest(secret, this.config.clientId, timestamp, nonce, body)
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)])
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xty-client-id': this.config.clientId,
        'x-xty-timestamp': timestamp,
        'x-xty-nonce': nonce,
        'x-xty-signature': signature,
      },
      body,
      signal: combinedSignal,
    })
    const responseBody = await response.text()
    if (!response.ok) {
      const compact = responseBody.trim().slice(0, 500)
      throw new Error(`反馈上传失败 HTTP ${response.status}${compact === '' ? '' : `：${compact}`}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(responseBody)
    } catch {
      throw new Error('反馈服务返回的不是有效 JSON')
    }
    return readReceipt(parsed, report.reportId)
  }
}
