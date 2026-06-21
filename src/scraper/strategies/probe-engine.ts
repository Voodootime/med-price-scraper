/**
 * Probe Engine — оркестратор автоопределения характеристик сайта.
 *
 * Pipeline (раздел 2.1 методологии):
 * 1. Fetch robots.txt → sitemap URLs, Disallow rules, crawl-delay
 * 2. Fetch homepage (через StaticFetcher) → framework, SSR/SPA, Schema.org, валюта
 * 3. Fetch sitemap → URL count, категоризация
 * 4. Probe catalog page (sample 3-5 URLs) → тест 5 ценовых стратегий
 * 5. Detect region_strategy
 * 6. Classify tier (T1-T10)
 * 7. Compute confidence score
 * 8. Return ProbeResult (готов к генерации spec.yaml)
 *
 * Документация: docs/scraping-methodology.md раздел 2
 */

import { logger } from '@/lib/logger'
import { getStaticFetcher } from '@/scraper/strategies/static-fetcher'
import { fetchAndParseRobots, type ParsedRobots } from '@/scraper/strategies/robots-fetcher'
import { fetchSitemap, type SitemapUrl } from '@/scraper/strategies/sitemap-fetcher'
import {
  detectFramework,
  type FrameworkDetectionResult,
} from '@/scraper/strategies/framework-detector'
import { testPriceStrategies } from '@/scraper/strategies/price-strategy-tester'
import {
  detectRegionStrategy,
  type RegionDetectionResult,
} from '@/scraper/strategies/region-detector'
import type {
  ProbeResult,
  Tier,
  PriceStrategyTest,
  RegionStrategy,
} from '@/scraper/types'
import type { ProbeEngine, ProbeOptions } from '@/scraper/interfaces'

interface ProbeContext {
  baseUrl: string
  region: string
  sampleSize: number
  skipVLM: boolean
}

export class DefaultProbeEngine implements ProbeEngine {
  readonly name = 'default-probe-engine'

  async probe(options: ProbeOptions): Promise<ProbeResult> {
    const ctx: ProbeContext = {
      baseUrl: options.baseUrl,
      region: options.region,
      sampleSize: options.sampleSize ?? 5,
      skipVLM: options.skipVLM ?? true,
    }

    const log = logger.child({
      module: 'probe-engine',
      baseUrl: ctx.baseUrl,
      region: ctx.region,
    })

    log.info('Starting probe sequence')

    // === Step 1: robots.txt ===
    log.info('Step 1: Fetching robots.txt')
    const robots = await fetchAndParseRobots(ctx.baseUrl)

    // === Step 2: homepage ===
    log.info('Step 2: Fetching homepage')
    const fetcher = getStaticFetcher()
    const homepageResult = await fetcher.fetch({
      url: ctx.baseUrl,
      region: ctx.region,
      tier: 'T1', // начинаем с T1, уточним позже
      timeoutMs: 30000,
      retries: 2,
    })

    if (homepageResult.status !== 200) {
      throw new Error(`Homepage returned status ${homepageResult.status}`)
    }

    const homepageHtml = homepageResult.body
    const frameworkResult = detectFramework(homepageHtml)

    log.info(
      {
        framework: frameworkResult.framework,
        isSSR: frameworkResult.isSSR,
        hasSchemaOrg: frameworkResult.hasSchemaOrg,
        currency: frameworkResult.currencyFormat,
      },
      'Framework detected'
    )

    // === Step 3: sitemap ===
    log.info('Step 3: Fetching sitemap')
    const sitemapUrls = robots?.sitemaps ?? [`${ctx.baseUrl}/sitemap.xml`]
    const allSitemapUrls: SitemapUrl[] = []

    for (const smUrl of sitemapUrls.slice(0, 3)) {
      // limit to first 3 sitemaps for probe
      try {
        const urls = await fetchSitemap(smUrl, {
          maxUrls: 10000, // limit for probe
          timeoutMs: 30000,
        })
        allSitemapUrls.push(...urls)
        log.info({ sitemapUrl: smUrl, count: urls.length }, 'Sitemap fetched')
      } catch (e) {
        log.warn({ sitemapUrl: smUrl, err: (e as Error).message }, 'Sitemap fetch failed')
      }
    }

    const allUrlStrings = allSitemapUrls.map((u) => u.url)
    log.info({ totalUrls: allUrlStrings.length }, 'Total URLs from sitemap')

    // === Step 4: sample URLs + price strategy test ===
    log.info('Step 4: Testing price strategies on sample URLs')
    const sampleUrls = pickSampleUrls(allUrlStrings, ctx.sampleSize, ctx.baseUrl)
    const sampleHtmls: string[] = []

    for (const url of sampleUrls) {
      try {
        const result = await fetcher.fetch({
          url,
          region: ctx.region,
          tier: 'T1',
          timeoutMs: 20000,
          retries: 1,
          rateLimitMs: 1000,
        })
        if (result.status === 200) {
          sampleHtmls.push(result.body)
        }
      } catch (e) {
        log.warn({ url, err: (e as Error).message }, 'Sample URL fetch failed')
      }
    }

    // Также тестируем на homepage
    sampleHtmls.push(homepageHtml)

    const priceStrategyResults = await testPriceStrategies({
      sampleUrls,
      sampleHtmls,
    })

    const successfulStrategies = priceStrategyResults.filter((s) => s.success)
    log.info(
      {
        total: priceStrategyResults.length,
        successful: successfulStrategies.length,
        best: successfulStrategies[0]?.strategy,
      },
      'Price strategies tested'
    )

    // === Step 5: region strategy ===
    log.info('Step 5: Detecting region strategy')
    const regionDetection: RegionDetectionResult = detectRegionStrategy({
      baseUrl: ctx.baseUrl,
      homepageHtml,
      sitemapUrls: allUrlStrings,
    })

    log.info(
      { strategy: regionDetection.strategy.type, confidence: regionDetection.confidence },
      'Region strategy detected'
    )

    // === Step 6: tier classification ===
    log.info('Step 6: Classifying tier')
    const tier = classifyTier(frameworkResult, priceStrategyResults, regionDetection.strategy)
    const tierReasoning = buildTierReasoning(tier, frameworkResult, priceStrategyResults)

    log.info({ tier, reasoning: tierReasoning }, 'Tier classified')

    // === Step 7: confidence score ===
    const confidenceScore = computeConfidence({
      framework: frameworkResult,
      priceStrategies: priceStrategyResults,
      regionStrategy: regionDetection,
      sitemapUrlsCount: allUrlStrings.length,
      tier,
    })

    log.info({ confidence: confidenceScore }, 'Confidence computed')

    // === Step 8: assemble ProbeResult ===
    const probeResult: ProbeResult = {
      baseUrl: ctx.baseUrl,
      probedAt: new Date(),
      framework: frameworkResult.framework,
      isSSR: frameworkResult.isSSR,
      hasEmbeddedState: frameworkResult.hasEmbeddedState,
      hasSchemaOrg: frameworkResult.hasSchemaOrg,
      currencyFormat: frameworkResult.currencyFormat,
      robotsTxt: {
        sitemaps: robots?.sitemaps ?? [],
        disallow: robots?.disallow ?? [],
        crawlDelay: robots?.crawlDelay,
      },
      sitemapUrls,
      totalUrlsDiscovered: allUrlStrings.length,
      priceStrategies: priceStrategyResults,
      regionStrategy: regionDetection.strategy,
      tier,
      tierReasoning,
      antiBotHints: frameworkResult.antiBotHints,
      confidenceScore,
      homepageSize: homepageHtml.length,
      sampleUrls,
    }

    log.info(
      {
        tier,
        framework: frameworkResult.framework,
        confidence: confidenceScore,
        urlsDiscovered: allUrlStrings.length,
      },
      'Probe completed'
    )

    return probeResult
  }

  async generateSpec(result: ProbeResult): Promise<string> {
    return generateSpecYaml(result)
  }

  computeConfidence(result: ProbeResult): number {
    return result.confidenceScore
  }
}

// ============================================================================
// Tier classification
// ============================================================================

function classifyTier(
  framework: FrameworkDetectionResult,
  priceStrategies: PriceStrategyTest[],
  _regionStrategy: RegionStrategy
): Tier {
  const bestStrategy = priceStrategies.find((s) => s.success)

  // T1+Schema.org — если Schema.org найден и цена извлечена
  if (framework.hasSchemaOrg && bestStrategy?.strategy === 'schema_org') {
    return 'T1_schema_org'
  }

  // T1 static — если цены в HTML, framework = bitrix/wordpress/tilda
  if (
    bestStrategy?.success &&
    ['schema_org', 'data_attributes', 'css_class', 'seo_text_block'].includes(
      bestStrategy.strategy
    )
  ) {
    return 'T1'
  }

  // T2 SSR+state — если есть embedded state и цены в JSON
  if (framework.hasEmbeddedState && bestStrategy?.strategy === 'embedded_json') {
    return 'T2'
  }

  // T3-T4 — SPA без SSR
  if (!framework.isSSR) {
    // Если есть антибот — T6/T7
    if (framework.antiBotHints.cloudflare) return 'T6'
    if (
      framework.antiBotHints.recaptcha ||
      framework.antiBotHints.datadome ||
      framework.antiBotHints.perimeterX
    ) {
      return 'T7'
    }
    return 'T4'
  }

  // Если цены не найдены, но есть SSR — вероятно T3 (SPA + API)
  if (framework.isSSR && !bestStrategy?.success) {
    return 'T3'
  }

  // Fallback
  return 'T1'
}

function buildTierReasoning(
  tier: Tier,
  framework: FrameworkDetectionResult,
  priceStrategies: PriceStrategyTest[]
): string {
  const bestStrategy = priceStrategies.find((s) => s.success)
  const parts: string[] = []

  parts.push(`framework=${framework.framework}`)
  parts.push(`isSSR=${framework.isSSR}`)
  if (framework.hasSchemaOrg) parts.push('hasSchemaOrg=true')
  if (framework.hasEmbeddedState) parts.push('hasEmbeddedState=true')
  if (bestStrategy) {
    parts.push(`bestStrategy=${bestStrategy.strategy}(${bestStrategy.itemsExtracted} items)`)
  }

  switch (tier) {
    case 'T1_schema_org':
      return `Tier T1+Schema.org: ${parts.join(', ')}. Schema.org microdata — эталонный случай.`
    case 'T1':
      return `Tier T1: ${parts.join(', ')}. Static HTML с ценами в DOM.`
    case 'T2':
      return `Tier T2: ${parts.join(', ')}. SSR + embedded JSON state.`
    case 'T3':
      return `Tier T3: ${parts.join(', ')}. SPA + JSON API (требует page_reader для рендера).`
    case 'T4':
      return `Tier T4: ${parts.join(', ')}. SPA без API-доступа (требует Playwright).`
    case 'T6':
      return `Tier T6: ${parts.join(', ')}. Light antibot (Cloudflare).`
    case 'T7':
      return `Tier T7: ${parts.join(', ')}. Heavy antibot.`
    default:
      return `Tier ${tier}: ${parts.join(', ')}.`
  }
}

// ============================================================================
// Confidence score
// ============================================================================

interface ConfidenceInput {
  framework: FrameworkDetectionResult
  priceStrategies: PriceStrategyTest[]
  regionStrategy: RegionDetectionResult
  sitemapUrlsCount: number
  tier: Tier
}

function computeConfidence(input: ConfidenceInput): number {
  let score = 0
  const { framework, priceStrategies, regionStrategy, sitemapUrlsCount, tier } = input

  // Framework confidence
  if (framework.framework !== 'unknown') score += 15

  // Schema.org
  if (framework.hasSchemaOrg) score += 25

  // Embedded state detected
  if (framework.hasEmbeddedState) score += 15

  // Successful price strategy
  const successfulStrategies = priceStrategies.filter((s) => s.success)
  if (successfulStrategies.length > 0) {
    score += 20
    if (successfulStrategies.length > 1) score += 5 // multi-strategy support
  }

  // Region strategy detected (not 'none')
  if (regionStrategy.strategy.type !== 'none') {
    score += 15
  }

  // Sitemap available
  if (sitemapUrlsCount > 100) {
    score += 10
  }

  // Tier-specific adjustments
  if (tier === 'T1_schema_org') score += 10
  if (tier === 'T7' || tier === 'T8') score -= 20 // hard cases, low confidence

  return Math.max(0, Math.min(100, score))
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Выбрать sample URL'ы для тестирования стратегий.
 * Приоритет: catalog/service URLs, разные path patterns.
 */
function pickSampleUrls(urls: string[], sampleSize: number, baseUrl: string): string[] {
  if (urls.length === 0) return [baseUrl]

  // Категоризируем
  const catalogUrls: string[] = []
  const serviceUrls: string[] = []
  const otherUrls: string[] = []

  for (const url of urls) {
    try {
      const u = new URL(url)
      const path = u.pathname.toLowerCase()
      if (/(catalog|katalog|analizy)/.test(path)) {
        catalogUrls.push(url)
      } else if (/(services|uslugi|cure|vectors)/.test(path)) {
        serviceUrls.push(url)
      } else if (!/(doctors|articles|news|press|blog)/.test(path)) {
        otherUrls.push(url)
      }
    } catch {
      // skip
    }
  }

  // Mix: prioritize catalog > service > other
  const mixed: string[] = []
  const halfSize = Math.floor(sampleSize / 2)

  // Берем catalog first
  for (let i = 0; i < catalogUrls.length && mixed.length < halfSize; i++) {
    const idx = Math.floor(i * (catalogUrls.length / halfSize))
    if (catalogUrls[idx]) mixed.push(catalogUrls[idx])
  }

  // Then service
  for (let i = 0; i < serviceUrls.length && mixed.length < sampleSize - 1; i++) {
    const idx = Math.floor(i * (serviceUrls.length / Math.max(1, sampleSize - 1 - mixed.length)))
    if (serviceUrls[idx] && !mixed.includes(serviceUrls[idx])) {
      mixed.push(serviceUrls[idx])
    }
  }

  // Fill with other
  for (const url of otherUrls) {
    if (mixed.length >= sampleSize) break
    if (!mixed.includes(url)) mixed.push(url)
  }

  // Always include homepage as last sample
  if (!mixed.includes(baseUrl)) {
    mixed.push(baseUrl)
  }

  return mixed.slice(0, sampleSize)
}

// ============================================================================
// Spec YAML generator
// ============================================================================

function generateSpecYaml(result: ProbeResult): string {
  const bestStrategy = result.priceStrategies.find((s) => s.success)
  const date = result.probedAt.toISOString()

  return `# Auto-generated by Probe Engine v1.0
competitor: ${new URL(result.baseUrl).hostname.replace(/^www\./, '')}
base_url: ${result.baseUrl}
tier: ${result.tier}
auto_generated: true
confidence: ${result.confidenceScore}
generated_at: ${date}
generated_by: probe-engine

region_strategy:
  type: ${result.regionStrategy.type}
  ${result.regionStrategy.param ? `param: ${result.regionStrategy.param}` : '# no param'}
  ${Object.keys(result.regionStrategy.mapping).length > 0 ? `mapping: ${JSON.stringify(result.regionStrategy.mapping)}` : 'mapping: {}'}
  ${result.regionStrategy.note ? `note: '${result.regionStrategy.note}'` : ''}

discovery:
  type: sitemap
  sitemap_urls:
${result.sitemapUrls.map((u) => `    - ${u}`).join('\n')}
  expected_pages: ${result.totalUrlsDiscovered}

fetcher:
  type: ${result.tier === 'T1_schema_org' || result.tier === 'T1' || result.tier === 'T2' ? 'static_curl' : 'page_reader'}
  rate_limit_ms: 2000
  retries: 3
  backoff: exponential

parsers:
${bestStrategy ? `  - name: ${bestStrategy.strategy}_primary
    type: ${bestStrategy.strategy}
    priority: 1
    confidence: ${bestStrategy.confidence}` : '  # no successful strategy detected'}

external_id:
  source: url_suffix
  fallback: slug

validation:
  min_items: ${Math.max(100, Math.floor(result.totalUrlsDiscovered * 0.5))}
  price_range: [50, 1000000]
  allow_zero_price: false
  pages_with_price_ratio: 0.7

schedule:
  cron: "0 3 * * *"
  timezone: Europe/Moscow

robots_compliance:
  respect_robots_txt: true
  crawl_delay: ${result.robotsTxt.crawlDelay ?? 2}s
`
}

// Singleton
let probeEngineInstance: DefaultProbeEngine | null = null

export function getProbeEngine(): DefaultProbeEngine {
  if (!probeEngineInstance) {
    probeEngineInstance = new DefaultProbeEngine()
  }
  return probeEngineInstance
}
