/**
 * Static Fetcher — базовый HTTP-клиент на undici (built-in fetch).
 *
 * Особенности:
 * - HTTP/2 по умолчанию
 * - Retry с exponential backoff (1s → 2s → 4s → 8s → 16s)
 * - Rate limit per domain (через delay)
 * - User-Agent ротация
 * - Conditional requests (If-Modified-Since, If-None-Match) — planned
 * - Content-hash для idempotency
 *
 * Документация: docs/scraping-methodology.md раздел 11, 12
 */

import { logger } from '@/lib/logger'
import { sha256 } from '@/scraper/utils/price'
import type { FetchResult, Tier } from '@/scraper/types'
import type { Fetcher, FetcherOptions } from '@/scraper/interfaces'

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
]

function pickUserAgent(custom?: string): string {
  if (custom) return custom
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

function delay(ms: number, jitterPct = 0.2): Promise<void> {
  const jitter = ms * jitterPct * (Math.random() * 2 - 1)
  const actual = Math.max(0, ms + jitter)
  return new Promise((resolve) => setTimeout(resolve, actual))
}

interface StaticFetcherConfig {
  defaultTimeoutMs?: number
  defaultRetries?: number
  defaultRateLimitMs?: number
}

export class StaticFetcher implements Fetcher {
  readonly name = 'static_curl'
  readonly supportedTiers: Tier[] = ['T1', 'T1_schema_org', 'T2']

  private config: Required<StaticFetcherConfig>

  constructor(config: StaticFetcherConfig = {}) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30000,
      defaultRetries: config.defaultRetries ?? 3,
      defaultRateLimitMs: config.defaultRateLimitMs ?? 2000,
    }
  }

  canHandle(options: FetcherOptions): boolean {
    return ['T1', 'T1_schema_org', 'T2'].includes(options.tier)
  }

  async fetch(options: FetcherOptions): Promise<FetchResult> {
    const {
      url,
      timeoutMs = this.config.defaultTimeoutMs,
      retries = this.config.defaultRetries,
      rateLimitMs = this.config.defaultRateLimitMs,
      headers = {},
      proxyUrl,
    } = options

    const log = logger.child({ fetcher: 'static_curl', url })
    const startTime = Date.now()
    let lastError: Error | null = null
    let attempt = 0

    // Apply rate limit before fetch
    await delay(rateLimitMs)

    for (attempt = 0; attempt <= retries; attempt++) {
      try {
        const fetchHeaders: Record<string, string> = {
          'User-Agent': pickUserAgent(headers['User-Agent']),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          ...headers,
        }

        if (proxyUrl) {
          log.warn({ proxyUrl }, 'Proxy requested but not yet implemented in StaticFetcher')
        }

        const controller = new AbortController()
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

        const response = await fetch(url, {
          method: 'GET',
          headers: fetchHeaders,
          signal: controller.signal,
          redirect: 'follow',
        })

        clearTimeout(timeoutHandle)

        const body = await response.text()
        const durationMs = Date.now() - startTime
        const contentHash = await sha256(body)

        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value
        })

        const result: FetchResult = {
          url: response.url || url,
          status: response.status,
          headers: responseHeaders,
          body,
          contentHash,
          fetchedAt: new Date(),
          durationMs,
          tier: options.tier,
          retries: attempt,
          proxyUsed: proxyUrl,
          fromCache: false,
        }

        log.info(
          {
            status: response.status,
            durationMs,
            bytes: body.length,
            attempt,
            hash: contentHash.slice(0, 12),
          },
          'Fetch succeeded'
        )

        return result
      } catch (e) {
        lastError = e as Error
        const err = e as Error & { name?: string }

        if (attempt < retries) {
          const backoffMs = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s, 8s, 16s
          log.warn({ attempt, backoffMs, err: err.message }, 'Fetch failed, retrying')
          await delay(backoffMs, 0) // no jitter on backoff
        } else {
          log.error({ attempt, err: err.message }, 'Fetch failed after all retries')
        }
      }
    }

    // All retries exhausted
    const durationMs = Date.now() - startTime
    log.error({ durationMs, err: lastError?.message }, 'Fetch ultimately failed')

    throw new Error(
      `Fetch failed for ${url} after ${attempt} attempts: ${lastError?.message ?? 'unknown error'}`
    )
  }
}

// Singleton instance
let staticFetcherInstance: StaticFetcher | null = null

export function getStaticFetcher(): StaticFetcher {
  if (!staticFetcherInstance) {
    staticFetcherInstance = new StaticFetcher()
  }
  return staticFetcherInstance
}
