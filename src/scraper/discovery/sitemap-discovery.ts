import { logger } from '@/lib/logger'
import type { DiscoveryOptions, DiscoveryResult, DiscoveryStrategy } from '@/scraper/interfaces'
import type { DiscoveredUrl } from '@/scraper/types'
import { fetchAndParseRobots } from '@/scraper/strategies/robots-fetcher'
import { fetchSitemap } from '@/scraper/strategies/sitemap-fetcher'
import {
  categorizeUrl,
  hasCitySegment,
  isLikelyPriceUrl,
  matchesTargetRegion,
  normalizeDiscoveryUrl,
  scoreLikelyPriceUrl,
} from './url-classifier'

const log = logger.child({ module: 'sitemap-discovery' })

const DEFAULT_MAX_URLS = 5000
const SITEMAP_TIMEOUT_MS = 30000
const MIN_SITEMAP_SCAN_URLS = 10000
const MAX_SITEMAP_SCAN_URLS = 10000

export class SitemapDiscoveryStrategy implements DiscoveryStrategy {
  readonly name = 'sitemap'
  readonly priority = 1

  canHandle(options: DiscoveryOptions): boolean {
    try {
      const url = new URL(options.baseUrl)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  async discover(options: DiscoveryOptions): Promise<DiscoveryResult> {
    const errors: string[] = []
    const maxUrls = options.maxUrls ?? DEFAULT_MAX_URLS
    const origin = toOrigin(options.baseUrl)

    if (!origin) {
      return {
        urls: [],
        strategy: this.name,
        totalDiscovered: 0,
        filteredToPriceUrls: 0,
        errors: [`Invalid baseUrl: ${options.baseUrl}`],
      }
    }

    const sitemapUrls = await this.resolveSitemapUrls(origin, options, errors)
    const discovered = new Map<string, DiscoveredUrl>()
    const scores = new Map<string, number>()
    let totalDiscovered = 0

    for (const sitemapUrl of sitemapUrls) {
      try {
        const scanLimit = Math.min(
          MAX_SITEMAP_SCAN_URLS,
          Math.max(MIN_SITEMAP_SCAN_URLS, maxUrls * 200)
        )
        const urls = await fetchSitemap(sitemapUrl, {
          maxUrls: scanLimit,
          timeoutMs: SITEMAP_TIMEOUT_MS,
        })
        totalDiscovered += urls.length

        for (const sitemapEntry of urls) {
          const normalized = normalizeDiscoveryUrl(sitemapEntry.url)
          if (!normalized || discovered.has(normalized)) continue
          if (!isSameSite(origin, normalized)) continue
          if (!matchesTargetRegion(normalized, options.region, options.regionStrategy)) {
            log.debug({ url: normalized, region: options.region, strategy: options.regionStrategy.type }, 'URL rejected by region filter')
            continue
          }

          const category = categorizeUrl(normalized)
          if (!isLikelyPriceUrl(normalized, category)) continue

          discovered.set(normalized, {
            url: normalized,
            category,
            hasCitySegment: hasCitySegment(normalized, options.regionStrategy),
            depth: 0,
            expected: category === 'other' ? 'uncertain' : true,
          })
          scores.set(normalized, scoreLikelyPriceUrl(normalized, category))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`Failed to process sitemap ${sitemapUrl}: ${message}`)
      }
    }

    const urls = [...discovered.values()]
      .sort((a, b) => (scores.get(b.url) ?? 0) - (scores.get(a.url) ?? 0))
      .slice(0, maxUrls)
    log.info(
      { baseUrl: options.baseUrl, sitemapUrls: sitemapUrls.length, totalDiscovered, filtered: urls.length },
      'Sitemap discovery complete'
    )

    return {
      urls,
      strategy: this.name,
      totalDiscovered,
      filteredToPriceUrls: urls.length,
      errors,
    }
  }

  private async resolveSitemapUrls(
    origin: string,
    options: DiscoveryOptions,
    errors: string[]
  ): Promise<string[]> {
    const fromProbe = options.probeResult?.robotsTxt?.sitemaps ?? options.probeResult?.sitemapUrls ?? []
    if (fromProbe.length > 0) return uniqueValidUrls(fromProbe)

    try {
      const robots = await fetchAndParseRobots(origin)
      if (robots?.sitemaps.length) return uniqueValidUrls(robots.sitemaps)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Failed to resolve robots.txt: ${message}`)
    }

    return [`${origin}/sitemap.xml`]
  }
}

let singleton: SitemapDiscoveryStrategy | null = null

export function getSitemapDiscoveryStrategy(): SitemapDiscoveryStrategy {
  singleton ??= new SitemapDiscoveryStrategy()
  return singleton
}

function toOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin
  } catch {
    return null
  }
}

function uniqueValidUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => normalizeDiscoveryUrl(url)).filter((url): url is string => Boolean(url)))]
}

function isSameSite(origin: string, url: string): boolean {
  try {
    return new URL(origin).hostname === new URL(url).hostname
  } catch {
    return false
  }
}
