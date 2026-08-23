import { afterEach, describe, expect, it, vi } from 'vitest'
import receiver, { readReport, verifyOfficialRequest } from '../src/index.js'

function base64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function sign(secret: string, clientId: string, timestamp: string, nonce: string, body: string): Promise<string> {
  const bodyHash = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64Url(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${clientId}\n${timestamp}\n${nonce}\n${bodyHash}`),
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe('official Harness request verification', () => {
  it('accepts the shared client signing vector', async () => {
    const request = new Request('https://feedback.example/v1/feedback', {
      method: 'POST',
      headers: {
        'x-xty-client-id': 'xiaotangyuan-official',
        'x-xty-timestamp': '1786800000000',
        'x-xty-nonce': '00000000-0000-4000-8000-000000000000',
        'x-xty-signature': 'Bo0pb_1erWEver5SttSVDl1goiaEzmNPjuiJ9wjJTwo',
      },
    })
    await expect(verifyOfficialRequest(
      request,
      '{"hello":"world"}',
      { 'xiaotangyuan-official': '01234567890123456789012345678901' },
      1786800000000,
    )).resolves.toBe('xiaotangyuan-official')
  })

  it('rejects a request without a valid official signature', async () => {
    const request = new Request('https://feedback.example/v1/feedback', {
      method: 'POST',
      headers: {
        'x-xty-client-id': 'xiaotangyuan-official',
        'x-xty-timestamp': '1786800000000',
        'x-xty-nonce': '10000000-0000-4000-8000-000000000000',
        'x-xty-signature': 'invalid',
      },
    })
    await expect(verifyOfficialRequest(
      request,
      '{"hello":"world"}',
      { 'xiaotangyuan-official': '01234567890123456789012345678901' },
      1786800000000,
    )).rejects.toThrow('signature')
  })
})

describe('feedback report schema', () => {
  it('accepts a model-authored fishing feature request with the exact player quote', () => {
    expect(readReport({
      schemaVersion: 1,
      reportId: '00000000-0000-4000-8000-000000000001',
      submittedAt: '2026-08-16T10:00:00.000Z',
      source: {
        product: 'dsh-xiaotangyuan-game',
        pluginVersion: '0.4.2',
        clientId: 'xiaotangyuan-official',
      },
      category: 'feature_request',
      title: '增加钓鱼功能',
      summary: '玩家希望小汤圆能够在星露谷物语中协助钓鱼。',
      playerQuote: '如果能够加钓鱼功能就好了',
      gameId: 'stardew-valley',
      adapterId: 'qimidandapigu.StardewAgent',
    }).playerQuote).toBe('如果能够加钓鱼功能就好了')
  })

  it('creates a private GitHub issue after official-request verification', async () => {
    const secret = '01234567890123456789012345678901'
    const clientId = 'xiaotangyuan-official'
    const timestamp = String(Date.now())
    const nonce = '20000000-0000-4000-8000-000000000000'
    const report = {
      schemaVersion: 1,
      reportId: '00000000-0000-4000-8000-000000000002',
      submittedAt: '2026-08-16T10:00:00.000Z',
      source: { product: 'dsh-xiaotangyuan-game', pluginVersion: '0.4.2', clientId },
      category: 'feature_request',
      title: '增加钓鱼功能',
      summary: '玩家希望小汤圆能够在星露谷物语中协助钓鱼。',
      playerQuote: '如果能够加钓鱼功能就好了',
      gameId: 'stardew-valley',
      adapterId: 'qimidandapigu.StardewAgent',
    }
    const body = JSON.stringify(report)
    const github = vi.fn().mockResolvedValue(new Response(JSON.stringify({ number: 42 }), { status: 201 }))
    vi.stubGlobal('fetch', github)
    const response = await receiver.fetch(new Request('https://feedback.example/v1/feedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xty-client-id': clientId,
        'x-xty-timestamp': timestamp,
        'x-xty-nonce': nonce,
        'x-xty-signature': await sign(secret, clientId, timestamp, nonce, body),
      },
      body,
    }), {
      XTY_FEEDBACK_CLIENTS_JSON: JSON.stringify({ [clientId]: secret }),
      GITHUB_TOKEN: 'test-token',
      GITHUB_OWNER: 'owner',
      GITHUB_REPO: 'private-feedback',
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      reportId: report.reportId,
      issueNumber: 42,
    })
    expect(github).toHaveBeenCalledOnce()
    expect(github.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/owner/private-feedback/issues')
    expect(String(github.mock.calls[0]?.[1]?.body)).toContain('如果能够加钓鱼功能就好了')
  })
})
