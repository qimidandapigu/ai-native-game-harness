import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  mapZhipuResponse,
  ZHIPU_SEARCH_PROVIDER_ID,
  ZhipuSearchProvider,
  type ZhipuSearchProviderOptions,
} from '../src/web-search-zhipu.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function options(overrides: Partial<ZhipuSearchProviderOptions> = {}): ZhipuSearchProviderOptions {
  return {
    apiKeyEnv: 'ZHIPU_API_KEY' as ZhipuSearchProviderOptions['apiKeyEnv'],
    resolveApiKey: async () => 'test-only-key',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    searchEngine: 'search_std',
    ...overrides,
  }
}

describe('Zhipu web search provider', () => {
  it('maps structured search sources and removes duplicate URLs', () => {
    expect(mapZhipuResponse({
      search_result: [
        { link: 'https://example.com/a', title: 'A', content: '摘要', publish_date: '2026/08/29' },
        { link: 'https://example.com/a', title: 'duplicate' },
        { link: 'not-a-url', title: 'invalid' },
      ],
    })).toEqual({
      sources: [{
        url: 'https://example.com/a',
        title: 'A',
        snippet: '摘要',
        publishedAt: '2026-08-29',
      }],
      truncated: false,
    })
  })

  it('calls the Zhipu structured Web Search API', async () => {
    let recorded: unknown
    const provider = new ZhipuSearchProvider(() => options({ recordRequest: request => { recorded = request } }))
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(init?.headers).not.toHaveProperty('x-api-key')
      return new Response(JSON.stringify({
        search_result: [{ link: 'https://example.com/result', title: 'Result' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await provider.search({ query: 'latest release', maxResults: 3 })

    expect(provider.id).toBe(ZHIPU_SEARCH_PROVIDER_ID)
    expect(result.sources).toHaveLength(1)
    expect(recorded).toEqual({
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      body: {
        search_query: 'latest release',
        search_engine: 'search_std',
        search_intent: false,
        count: 3,
        content_size: 'medium',
      },
    })
    expect(JSON.stringify(recorded)).not.toContain('test-only-key')
  })

  it('fails clearly when the Zhipu credential is unavailable', async () => {
    const provider = new ZhipuSearchProvider(() => options({ resolveApiKey: async () => undefined }))
    await expect(provider.search({ query: 'test' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    } satisfies Partial<WebError>)
  })

  it('uses the Sogou minimum page size and caps an over-returning response', async () => {
    let requestedCount: unknown
    const provider = new ZhipuSearchProvider(() => options({ searchEngine: 'search_pro_sogou' }))
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestedCount = JSON.parse(String(init?.body)).count
      return new Response(JSON.stringify({
        search_result: Array.from({ length: 12 }, (_, index) => ({
          link: `https://example.com/${index}`,
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await provider.search({ query: 'latest release', maxResults: 3 })

    expect(requestedCount).toBe(10)
    expect(result.sources).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('rejects prose-only responses instead of pretending search succeeded', () => {
    expect(() => mapZhipuResponse({})).toThrow('no structured search_result array')
  })
})
