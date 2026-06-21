import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { loadConfig } from '@/lib/config'
import { getStaticFetcher } from '@/scraper/strategies/static-fetcher'
import { getSitemapDiscoveryStrategy } from '@/scraper/discovery'
import { getValidator } from '@/scraper/validation/default-validator'
import { parseHtmlPrices } from '@/scraper/parsers'
import { getProbeEngine } from '@/scraper/strategies/probe-engine'
import { computeDeltaPct, htmlStructureHash } from '@/scraper/utils/price'
import type {
  ProbeResult,
  FetchResult,
  RegionStrategy,
  UniversalPriceItem,
} from '@/scraper/types'
import type { ValidationRules } from '@/scraper/interfaces'

const log = logger.child({ module: 'scrape-runner' })

const DEFAULT_VALIDATION_RULES: ValidationRules = {
  minItems: 1,
  maxItems: 20000,
  priceRange: [1, 1_000_000],
  allowZeroPrice: false,
  pagesWithPriceRatio: 0.5,
  alertIfNullFieldsRate: 0.2,
  alertIfStructureDiff: 0.4,
}

export interface RunScrapeOptions {
  competitorId: string
  region?: string
  maxUrls?: number
  autoProbe?: boolean
}

export interface RunScrapeResult {
  runId: string
  status: 'success' | 'partial' | 'failed'
  urlsPlanned: number
  urlsFetched: number
  urlsSucceeded: number
  urlsFailed: number
  itemsExtracted: number
  itemsAdded: number
  itemsChanged: number
  validationErrors: string[]
}

export async function runScrape(options: RunScrapeOptions): Promise<RunScrapeResult> {
  const config = loadConfig()
  const region = options.region ?? config.TARGET_REGION
  const maxUrls = Math.max(1, Math.min(options.maxUrls ?? 25, 250))

  const competitor = await db.competitor.findUnique({
    where: { id: options.competitorId },
    include: {
      scrapeSpecs: {
        where: { status: 'active' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      probeResults: {
        orderBy: { probedAt: 'desc' },
        take: 1,
      },
    },
  })

  if (!competitor) {
    throw new Error(`Competitor not found: ${options.competitorId}`)
  }

  const resolved = await resolveScrapeInputs({
    competitor,
    region,
    autoProbe: options.autoProbe ?? true,
  })
  const probeResult = resolved.probeResult
  const regionStrategy = resolveRegionStrategy(competitor.regionStrategy, probeResult?.regionStrategy)
  const spec = resolved.specId ? { id: resolved.specId } : competitor.scrapeSpecs[0]

  const run = await db.scrapeRun.create({
    data: {
      competitorId: competitor.id,
      specId: spec?.id,
      region,
      status: 'running',
    },
  })

  try {
    await db.competitor.update({
      where: { id: competitor.id },
      data: { status: 'probing' },
    })

    const discovery = await getSitemapDiscoveryStrategy().discover({
      baseUrl: competitor.baseUrl,
      region,
      regionStrategy,
      maxUrls,
      probeResult: probeResult ?? undefined,
    })
    const plannedUrls = discovery.urls.slice(0, maxUrls)

    await db.scrapeRun.update({
      where: { id: run.id },
      data: { urlsPlanned: plannedUrls.length },
    })

    const fetcher = getStaticFetcher()
    const fetchedItems: UniversalPriceItem[] = []
    const validationErrors: string[] = [...discovery.errors]
    let urlsFetched = 0
    let urlsSucceeded = 0
    let urlsFailed = 0
    let contentHash: string | undefined

    for (const discovered of plannedUrls) {
      try {
        urlsFetched += 1
        const fetched = await fetchWithTrailingSlashFallback({
          fetcher,
          url: discovered.url,
          region,
          rateLimitMs: config.DEFAULT_RATE_LIMIT_MS,
        })

        if (fetched.status >= 400) {
          urlsFailed += 1
          validationErrors.push(`${discovered.url}: HTTP ${fetched.status}`)
          continue
        }

        urlsSucceeded += 1
        contentHash ??= await htmlStructureHash(fetched.body)
        const parsed = await parseHtmlPrices(fetched.body, fetched.url, {
          competitorId: competitor.id,
          region,
          scrapeRunId: run.id,
        })
        validationErrors.push(...parsed.errors.map((error) => `${discovered.url}: ${error}`))
        fetchedItems.push(...parsed.items)
      } catch (error) {
        urlsFailed += 1
        validationErrors.push(`${discovered.url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const validator = getValidator()
    const validation = validator.validateBatch(fetchedItems, DEFAULT_VALIDATION_RULES)
    validationErrors.push(...validation.errors)

    const persisted = validation.ok
      ? await persistItems({
          competitorId: competitor.id,
          runId: run.id,
          items: fetchedItems,
        })
      : { added: 0, changed: 0 }

    const status = computeRunStatus({
      urlsPlanned: plannedUrls.length,
      urlsSucceeded,
      urlsFailed,
      itemsExtracted: fetchedItems.length,
      validationOk: validation.ok,
    })
    const finishedAt = new Date()

    await db.scrapeRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt,
        durationMs: finishedAt.getTime() - run.startedAt.getTime(),
        urlsPlanned: plannedUrls.length,
        urlsFetched,
        urlsSucceeded,
        urlsFailed,
        itemsExtracted: fetchedItems.length,
        itemsAdded: persisted.added,
        itemsChanged: persisted.changed,
        nullFieldsRate: validation.itemsInvalid / Math.max(fetchedItems.length, 1),
        contentHash,
        errorMessage: status === 'success' ? null : validationErrors.slice(0, 10).join('\n'),
      },
    })

    await db.competitor.update({
      where: { id: competitor.id },
      data: {
        status: status === 'failed' ? 'needs_review' : 'active',
        lastScrapeAt: finishedAt,
        itemsCount: fetchedItems.length,
      },
    })

    return {
      runId: run.id,
      status,
      urlsPlanned: plannedUrls.length,
      urlsFetched,
      urlsSucceeded,
      urlsFailed,
      itemsExtracted: fetchedItems.length,
      itemsAdded: persisted.added,
      itemsChanged: persisted.changed,
      validationErrors,
    }
  } catch (error) {
    const finishedAt = new Date()
    const message = error instanceof Error ? error.message : String(error)

    await db.scrapeRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt,
        durationMs: finishedAt.getTime() - run.startedAt.getTime(),
        errorMessage: message,
        errorStack: error instanceof Error ? error.stack : undefined,
      },
    })

    await db.competitor.update({
      where: { id: competitor.id },
      data: { status: 'needs_review' },
    })

    log.error({ err: error, runId: run.id, competitorId: competitor.id }, 'Scrape run failed')
    throw error
  }
}

export function computeRunStatus(input: {
  urlsPlanned: number
  urlsSucceeded: number
  urlsFailed: number
  itemsExtracted: number
  validationOk: boolean
}): 'success' | 'partial' | 'failed' {
  if (input.urlsPlanned === 0 || input.urlsSucceeded === 0 || input.itemsExtracted === 0) return 'failed'
  if (!input.validationOk || input.urlsFailed > 0) return 'partial'
  return 'success'
}

async function persistItems(input: {
  competitorId: string
  runId: string
  items: UniversalPriceItem[]
}): Promise<{ added: number; changed: number }> {
  let added = 0
  let changed = 0

  for (const item of input.items) {
    const existingService = await db.service.findUnique({
      where: {
        competitorId_externalId: {
          competitorId: input.competitorId,
          externalId: item.externalId,
        },
      },
      include: {
        snapshots: {
          orderBy: { scrapedAt: 'desc' },
          take: 1,
        },
      },
    })

    const service = existingService
      ? await db.service.update({
          where: { id: existingService.id },
          data: {
            name: item.name,
            nameRaw: item.nameRaw,
            category: item.category,
            url: item.url,
            lastSeenAt: new Date(),
            isActive: true,
          },
        })
      : await db.service.create({
          data: {
            competitorId: input.competitorId,
            externalId: item.externalId,
            externalIdType: item.externalIdType,
            code: item.code,
            slug: item.slug,
            name: item.name,
            nameRaw: item.nameRaw,
            category: item.category,
            url: item.url,
          },
        })

    if (!existingService) added += 1

    const previousPrice = existingService?.snapshots[0]?.price
    if (previousPrice !== undefined && previousPrice !== item.price) changed += 1

    await db.priceSnapshot.create({
      data: {
        serviceId: service.id,
        price: item.price,
        pricePrevious: previousPrice,
        deltaPct: previousPrice !== undefined ? computeDeltaPct(previousPrice, item.price) : null,
        currency: item.currency,
        region: item.region,
        locationKey: item.locationKey ?? '',
        tariff: item.tariff,
        isMinPrice: item.isMinPrice,
        marketPrice: item.marketPrice,
        scrapeRunId: input.runId,
        parseStrategy: item.parseStrategy,
        parseConfidence: item.parseConfidence,
      },
    })
  }

  return { added, changed }
}

async function fetchWithTrailingSlashFallback(input: {
  fetcher: ReturnType<typeof getStaticFetcher>
  url: string
  region: string
  rateLimitMs: number
}): Promise<FetchResult> {
  const fetchOptions = {
    region: input.region,
    tier: 'T1' as const,
    timeoutMs: 20000,
    retries: 1,
    rateLimitMs: input.rateLimitMs,
  }

  const fetched = await input.fetcher.fetch({
    ...fetchOptions,
    url: input.url,
  })
  if (fetched.status !== 404 || !canTryTrailingSlash(input.url)) return fetched

  return input.fetcher.fetch({
    ...fetchOptions,
    url: `${input.url}/`,
  })
}

function canTryTrailingSlash(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/')) return false
    const lastSegment = parsed.pathname.split('/').filter(Boolean).at(-1) ?? ''
    return !lastSegment.includes('.')
  } catch {
    return false
  }
}

function resolveRegionStrategy(
  storedType?: string | null,
  probeStrategy?: RegionStrategy
): RegionStrategy {
  if (probeStrategy) return probeStrategy
  return {
    type: (storedType as RegionStrategy['type']) || 'none',
    mapping: {},
  }
}

async function resolveScrapeInputs(input: {
  competitor: {
    id: string
    baseUrl: string
    regionStrategy: string | null
    scrapeSpecs: Array<{ id: string }>
    probeResults: Array<{ probeReportJson: string }>
  }
  region: string
  autoProbe: boolean
}): Promise<{ probeResult: ProbeResult | null; specId?: string }> {
  const existingProbe = input.competitor.probeResults[0]?.probeReportJson
    ? JSON.parse(input.competitor.probeResults[0].probeReportJson) as ProbeResult
    : null

  if (existingProbe && input.competitor.scrapeSpecs[0]?.id) {
    return {
      probeResult: existingProbe,
      specId: input.competitor.scrapeSpecs[0].id,
    }
  }

  if (!input.autoProbe) {
    return {
      probeResult: existingProbe,
      specId: input.competitor.scrapeSpecs[0]?.id,
    }
  }

  await db.competitor.update({
    where: { id: input.competitor.id },
    data: { status: 'probing' },
  })

  const probeEngine = getProbeEngine()
  const probeResult = await probeEngine.probe({
    baseUrl: input.competitor.baseUrl,
    region: input.region,
    sampleSize: 5,
    skipVLM: true,
  })
  const specYaml = await probeEngine.generateSpec(probeResult)

  const probeRecord = await db.probeResult.create({
    data: {
      competitorId: input.competitor.id,
      probedAt: probeResult.probedAt,
      framework: probeResult.framework,
      isSSR: probeResult.isSSR,
      hasEmbeddedState: probeResult.hasEmbeddedState,
      hasSchemaOrg: probeResult.hasSchemaOrg,
      currencyFormat: probeResult.currencyFormat,
      tier: probeResult.tier,
      regionStrategy: probeResult.regionStrategy.type,
      sitemapUrlsCount: probeResult.sitemapUrls.length,
      priceUrlsCount: probeResult.totalUrlsDiscovered,
      confidenceScore: probeResult.confidenceScore,
      probeReportJson: JSON.stringify(probeResult),
    },
  })

  const nextVersion =
    (await db.scrapeSpec.count({ where: { competitorId: input.competitor.id } })) + 1
  const spec = await db.scrapeSpec.create({
    data: {
      competitorId: input.competitor.id,
      version: nextVersion,
      specYaml,
      autoGenerated: true,
      confidence: probeResult.confidenceScore,
      status: probeResult.confidenceScore >= 40 ? 'active' : 'needs_review',
      probeResultId: probeRecord.id,
      createdBy: 'scrape-runner',
    },
  })

  await db.competitor.update({
    where: { id: input.competitor.id },
    data: {
      tier: probeResult.tier,
      regionStrategy: probeResult.regionStrategy.type,
      lastProbeAt: probeResult.probedAt,
      confidenceScore: probeResult.confidenceScore,
    },
  })

  return { probeResult, specId: spec.id }
}
