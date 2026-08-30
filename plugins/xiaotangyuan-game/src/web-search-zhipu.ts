import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import {
  WebError,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from '@deepseek-ai/dsh-web'

export const name = 'xiaotangyuan-web-search-zhipu'
export const inject = ['web']
export const ZHIPU_SEARCH_PROVIDER_ID = 'zhipu-official'
export const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const ZHIPU_DEFAULT_SEARCH_ENGINE = 'search_pro_sogou'

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  searchEngine?: string
}

export interface ZhipuSearchProviderOptions {
  apiKeyEnv: CredentialRef
  resolveApiKey: () => Promise<string | undefined>
  baseURL: string
  searchEngine: string
  recordRequest?: (request: ZhipuSearchRequestRecord) => void
}

export interface ZhipuSearchRequestRecord {
  endpoint: string
  body: ZhipuWebSearchRequest
}

interface ZhipuWebSearchRequest {
  search_query: string
  search_engine: string
  search_intent: false
  count: number
  content_size: 'medium'
}

interface ZhipuWebSearchItem {
  link?: unknown
  title?: unknown
  content?: unknown
  publish_date?: unknown
}

interface ZhipuWebSearchResponse {
  search_result?: ZhipuWebSearchItem[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'web/zhipu-search-request': ZhipuSearchRequestRecord
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function publicationDate(value: unknown): string | undefined {
  const raw = nonEmpty(value)
  const match = raw?.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/u)
  return match === null || match === undefined ? undefined : `${match[1]}-${match[2]}-${match[3]}`
}

export function mapZhipuResponse(response: ZhipuWebSearchResponse): WebSearchResult {
  if (!Array.isArray(response.search_result)) {
    throw new WebError('Zhipu returned no structured search_result array', 'WEB_PROVIDER_ERROR')
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const item of response.search_result) {
    const url = nonEmpty(item.link)
    if (url === undefined || !URL.canParse(url) || seen.has(url)) continue
    seen.add(url)
    const title = nonEmpty(item.title)
    const snippet = nonEmpty(item.content)
    const publishedAt = publicationDate(item.publish_date)
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  return { sources, truncated: false }
}

export class ZhipuSearchProvider implements WebSearchProvider {
  readonly id = ZHIPU_SEARCH_PROVIDER_ID

  constructor(private readonly resolveOptions: () => ZhipuSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return URL.canParse(options.baseURL) && options.searchEngine.trim() !== ''
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    throwIfAborted(signal)

    let apiKey: string | undefined
    try {
      apiKey = await abortable(options.resolveApiKey(), signal)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Zhipu search credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new WebError(
        `Zhipu search has no API key for "${options.apiKeyEnv}"`,
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }

    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/web_search`
    const searchQuery = Array.from(request.query.trim()).slice(0, 70).join('')
    const count = Math.min(50, Math.max(1, request.maxResults ?? 8))
    const providerCount = options.searchEngine === 'search_pro_sogou'
      ? Math.min(50, Math.ceil(count / 10) * 10)
      : count
    const body: ZhipuWebSearchRequest = {
      search_query: searchQuery,
      search_engine: options.searchEngine,
      search_intent: false,
      count: providerCount,
      content_size: 'medium',
    }
    options.recordRequest?.({ endpoint, body })
    throwIfAborted(signal)

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'ai-native-game-harness/0.7.9',
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(`Zhipu search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let message = `Zhipu API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as { error?: { message?: unknown } | string; message?: unknown }
        const detail = typeof parsed.error === 'string' ? parsed.error : nonEmpty(parsed.error?.message) ?? nonEmpty(parsed.message)
        if (typeof detail === 'string' && detail !== '') message = detail
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const mapped = mapZhipuResponse(await response.json() as ZhipuWebSearchResponse)
      if (mapped.sources.length <= count) return mapped
      return { sources: mapped.sources.slice(0, count), truncated: true }
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`Zhipu returned an unprocessable search response: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(aborted(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

function aborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Zhipu search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function apply(ctx: Context, config: Config = {}): void {
  const apiKeyEnv = credentialRef(config.apiKeyEnv?.trim() || 'ZHIPU_API_KEY')
  const options = (): ZhipuSearchProviderOptions => ({
    apiKeyEnv,
    resolveApiKey: async () => (await ctx.get('credentials')?.resolve(apiKeyEnv))?.value
      ?? nonEmpty(process.env[apiKeyEnv]),
    baseURL: config.baseURL?.trim() || ZHIPU_DEFAULT_BASE_URL,
    searchEngine: config.searchEngine?.trim() || ZHIPU_DEFAULT_SEARCH_ENGINE,
    recordRequest: request => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/zhipu-search-request', request)
    },
  })
  ctx.web.registerSearchProvider(new ZhipuSearchProvider(options))
}
