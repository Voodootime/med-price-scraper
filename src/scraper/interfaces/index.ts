/**
 * Базовые интерфейсы универсального скрапера.
 *
 * Эти интерфейсы определяют контракты для всех подсистем движка:
 * - Fetcher (получение HTML/JSON)
 * - Parser (извлечение UniversalPriceItem)
 * - Normalizer (приведение к канонической форме)
 * - Validator (проверка корректности)
 * - DiscoveryStrategy (поиск URL с ценами)
 * - ProbeEngine (автоопределение характеристик сайта)
 *
 * Каждая реализация (T1, T2, T3, ...) должна реализовать соответствующий
 * интерфейс. Это даёт plug-in архитектуру: новые стратегии добавляются без
 * изменения core-логики.
 *
 * Документация: docs/scraping-methodology.md разделы 2-5
 */

import type {
  DiscoveredUrl,
  FetchResult,
  HealthEvaluation,
  PriceStrategyName,
  ProbeResult,
  RegionStrategy,
  ScrapeHealth,
  Tier,
  UniversalPriceItem,
  ValidationResult,
} from '@/scraper/types'

// ============================================================================
// FETCHER — получает HTML/JSON с сайта (раздел 11)
// ============================================================================

export interface FetcherOptions {
  url: string
  region: string
  locationKey?: string
  tier: Tier
  timeoutMs?: number
  retries?: number
  rateLimitMs?: number
  followRedirects?: boolean
  headers?: Record<string, string>
  proxyUrl?: string
}

export interface Fetcher {
  /** Уникальное имя стратегии (например, 'static_curl', 'page_reader', 'playwright') */
  readonly name: string

  /** Тиры, которые поддерживает этот fetcher */
  readonly supportedTiers: Tier[]

  /** Основной метод — получить контент по URL */
  fetch(options: FetcherOptions): Promise<FetchResult>

  /** Проверка, может ли fetcher обработать данный URL/тир */
  canHandle(options: FetcherOptions): boolean
}

// ============================================================================
// PARSER — извлекает UniversalPriceItem из FetchResult (раздел 4)
// ============================================================================

export interface ParseContext {
  competitorId: string
  region: string
  locationKey?: string
  tariff?: string
  specId?: string
  scrapeRunId: string
}

export interface ParseResult {
  items: UniversalPriceItem[]
  strategy: PriceStrategyName
  confidence: number // 0-100
  errors: string[]
  warnings: string[]
  rawHtmlS3Key?: string
}

export interface Parser {
  /** Уникальное имя парсера (соответствует PriceStrategyName) */
  readonly name: PriceStrategyName

  /** Приоритет (1 = высший) */
  readonly priority: number

  /** Основной метод — извлечь items из HTML/JSON */
  parse(html: string, url: string, context: ParseContext): Promise<ParseResult>

  /** Быстрая проверка — есть ли в HTML признаки этой стратегии */
  canParse(html: string): boolean
}

// ============================================================================
// NORMALIZER — приведение к канонической форме (раздел 6.1)
// ============================================================================

export interface Normalizer {
  /** Нормализовать название услуги (trim, lowercase, collapse spaces) */
  normalizeName(nameRaw: string): string

  /** Парсинг цены: "1 300 ₽" → 130000 (копейки), "от 530 р." → 53000 + isMinPrice=true */
  parsePrice(priceRaw: string): { price: number; isMinPrice: boolean; currency: string }

  /** Нормализация категории */
  normalizeCategory(category?: string): string | undefined

  /** LLM-нормализация названия (кэшированная) */
  normalizeNameWithLLM?(name: string): Promise<string>
}

// ============================================================================
// VALIDATOR — проверка корректности извлечённых данных (раздел 4.4)
// ============================================================================

export interface ValidationRules {
  minItems: number
  maxItems?: number
  priceRange: [number, number] // [min, max] в рублях
  allowZeroPrice: boolean
  pagesWithPriceRatio: number // 0-1, ожидаемая доля страниц с ценой
  alertIfItemsDropPct?: number // % снижения items для alert
  alertIfNullFieldsRate?: number // % null-полей для alert
  alertIfStructureDiff?: number // % diff структуры для alert
}

export interface Validator {
  /** Валидация одного item */
  validateItem(item: UniversalPriceItem, rules: ValidationRules): { ok: boolean; errors: string[] }

  /** Валидация batch'а items */
  validateBatch(items: UniversalPriceItem[], rules: ValidationRules): ValidationResult

  /** Валидация health scrape-run'а */
  evaluateHealth(health: ScrapeHealth, rules: ValidationRules): HealthEvaluation

  /** Scope validation: snap.region === config.targetRegion */
  validateScope(region: string, targetRegion: string): boolean
}

// ============================================================================
// DISCOVERY STRATEGY — поиск URL с ценами (раздел 3)
// ============================================================================

export interface DiscoveryOptions {
  baseUrl: string
  region: string
  regionStrategy: RegionStrategy
  maxDepth?: number
  maxUrls?: number
  rateLimitMs?: number
  probeResult?: ProbeResult
}

export interface DiscoveryResult {
  urls: DiscoveredUrl[]
  strategy: string // 'sitemap' | 'bfs_crawl' | 'web_search' | 'common_paths' | 'vlm_assisted'
  totalDiscovered: number
  filteredToPriceUrls: number
  errors: string[]
}

export interface DiscoveryStrategy {
  /** Уникальное имя стратегии */
  readonly name: string

  /** Приоритет (1 = высший) */
  readonly priority: number

  /** Основной метод — обнаружить URL с ценами */
  discover(options: DiscoveryOptions): Promise<DiscoveryResult>

  /** Быстрая проверка — подходит ли эта стратегия для сайта */
  canHandle(options: DiscoveryOptions): boolean
}

// ============================================================================
// PROBE ENGINE — автоопределение характеристик сайта (раздел 2)
// ============================================================================

export interface ProbeOptions {
  baseUrl: string
  region: string
  sampleSize?: number // сколько URL тестировать (default 5)
  skipVLM?: boolean // пропустить VLM fallback
}

export interface ProbeEngine {
  /** Основной метод — проанализировать сайт и вернуть ProbeResult */
  probe(options: ProbeOptions): Promise<ProbeResult>

  /** Сгенерировать spec.yaml из ProbeResult */
  generateSpec(result: ProbeResult): Promise<string>

  /** Вычислить confidence score (0-100) */
  computeConfidence(result: ProbeResult): number
}

// ============================================================================
// SCHEDULER — планировщик запусков
// ============================================================================

export interface ScheduleConfig {
  cron: string // cron expression
  timezone: string
  competitorId: string
  enabled: boolean
}

export interface Scheduler {
  /** Зарегистрировать расписание для конкурента */
  schedule(config: ScheduleConfig): Promise<void>

  /** Удалить расписание */
  unschedule(competitorId: string): Promise<void>

  /** Получить все расписания */
  listSchedules(): Promise<ScheduleConfig[]>

  /** Запустить scrape вручную */
  runNow(competitorId: string, region: string): Promise<string> // scrapeRunId
}

// ============================================================================
// SPEC — декларативное описание парсера для сайта (раздел 0.4.1)
// ============================================================================

export interface Spec {
  competitor: string
  baseUrl: string
  tier: Tier
  autoGenerated: boolean
  confidence: number
  generatedAt: string
  generatedBy: string

  regionStrategy: RegionStrategy

  discovery: {
    type: 'sitemap' | 'bfs_crawl' | 'link_analysis' | 'web_search' | 'common_paths' | 'vlm_assisted'
    sitemapUrls?: string[]
    urlFilter?: string
    expectedPages?: number
    maxDepth?: number
  }

  fetcher: {
    type: 'static_curl' | 'page_reader' | 'playwright' | 'stealth'
    userAgent?: string
    rateLimitMs?: number
    retries?: number
    backoff?: 'exponential' | 'linear' | 'fixed'
    proxyRequired?: boolean
  }

  parsers: Array<{
    name: PriceStrategyName
    type: string
    priority: number
    selectors?: Record<string, string>
    regex?: string
    trigger?: string
    confidence: number
  }>

  externalId: {
    source: 'url_suffix' | 'data_attr' | 'json_field' | 'slug' | 'name_hash'
    fallback?: string
  }

  validation: ValidationRules

  schedule: {
    cron: string
    timezone: string
  }

  normalization?: {
    nameCanonicalization?: 'none' | 'llm_cached'
    crossSourceMatching?: 'none' | 'embeddings'
  }

  robotsCompliance?: {
    respectRobotsTxt: boolean
    disallowedParams?: string[]
    crawlDelay?: number
  }
}

// ============================================================================
// SCRAPE RUN — контекст одного запуска сбора
// ============================================================================

export interface ScrapeRunContext {
  runId: string
  competitorId: string
  specId: string
  region: string
  startedAt: Date
  urlsPlanned: number
  urlsFetched: number
  urlsSucceeded: number
  urlsFailed: number
  itemsExtracted: number
  itemsChanged: number
  itemsAdded: number
  itemsRemoved: number
  status: 'running' | 'success' | 'failed' | 'partial' | 'cancelled'
}
