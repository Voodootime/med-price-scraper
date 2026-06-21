/**
 * Базовые типы универсального скрапера.
 *
 * Эти типы описывают:
 * - Tier (классификация сайтов T1-T10)
 * - RegionStrategy (как сайт привязывает цены к региону)
 * - UniversalPriceItem (единая модель данных из любого источника)
 * - ProbeResult (результат автоопределения характеристик сайта)
 *
 * Документация: docs/scraping-methodology.md разделы 1, 2, 6
 */

// ============================================================================
// TIER — классификация сайтов по сложности скрапинга (раздел 1 методологии)
// ============================================================================

export type Tier =
  | 'T1' // Static HTML — серверный рендер, цены в DOM, нет lazy-load
  | 'T1_schema_org' // T1 + Schema.org микроразметка (эталон)
  | 'T2' // SSR + embedded state (Next/Nuxt/Angular SSR, JSON в HTML)
  | 'T3' // SPA + JSON API (XHR/fetch доступен напрямую)
  | 'T4' // SPA без API-доступа (Playwright full render)
  | 'T5' // Lazy-loaded / infinite scroll (Playwright + scroll)
  | 'T6' // Light antibot (Cloudflare basic, stealth + residential proxy)
  | 'T7' // Heavy antibot (Datadome, PerimeterX, mobile proxy + VLM)
  | 'T8' // Visual / image-based (screenshot → VLM)
  | 'T9' // PDF / DOCX / XLSX прайсы
  | 'T10' // Веб-сервисы (Telegram-боты, API)

// ============================================================================
// REGION STRATEGY — как сайт привязывает цены к региону (раздел 0.4.1)
// ============================================================================

export type RegionStrategyType =
  | 'url_prefix' // /{city}/catalog/...  (Gemotest)
  | 'url_path_segment' // /catalog/{city}/{slug}/  (CMD)
  | 'url_subdomain' // https://{city}.medsi.ru/...  (Medsi)
  | 'url_query' // /services/x/?clinic={slug}  (Medsi clinics — часто запрещено robots.txt)
  | 'cookie' // Cookie: cityId={id}  (Helix)
  | 'ip_default' // SSR определяет по IP  (Helix)
  | 'tariff_select' // Вкладка тарифа в HTML  (Veramed)
  | 'none' // Регион не влияет  (Altamed+)

export interface RegionStrategy {
  type: RegionStrategyType
  param?: string // имя параметра/префикса/cookie
  mapping: Record<string, string> // { moscow: 'msk', spb: 'spb', ... }
  note?: string
  scopeOptimization?: string // описание оптимизации
}

// ============================================================================
// FRAMEWORK — определение веб-фреймворка (раздел 2.2)
// ============================================================================

export type Framework =
  | 'bitrix'
  | 'wordpress'
  | 'drupal'
  | 'next'
  | 'nuxt'
  | 'angular'
  | 'vue'
  | 'react-spa'
  | 'tilda'
  | 'custom'
  | 'unknown'

// ============================================================================
// PROBE RESULT — результат автоопределения характеристик сайта (раздел 2.2)
// ============================================================================

export interface AntiBotHints {
  cloudflare?: boolean
  recaptcha?: boolean
  datadome?: boolean
  perimeterX?: boolean
  akamai?: boolean
  jsChallenge?: boolean
  rateLimitHeaders?: string[]
}

export interface ProbeResult {
  // Базовая информация
  baseUrl: string
  probedAt: Date

  // Framework detection
  framework: Framework
  isSSR: boolean // server-side rendering
  hasEmbeddedState: boolean // __NEXT_DATA__, G.json./api/, window.__INITIAL_STATE__
  hasSchemaOrg: boolean // itemprop="price"
  currencyFormat: '₽' | 'руб.' | 'р.' | 'rub' | 'mixed'

  // robots.txt и sitemap
  robotsTxt: {
    sitemaps: string[]
    disallow: string[]
    crawlDelay?: number
  }
  sitemapUrls: string[]
  totalUrlsDiscovered: number

  // Price strategy testing
  priceStrategies: PriceStrategyTest[]

  // Region strategy
  regionStrategy: RegionStrategy

  // Tier classification
  tier: Tier
  tierReasoning: string // почему этот тир

  // Anti-bot
  antiBotHints: AntiBotHints

  // Confidence
  confidenceScore: number // 0-100

  // Метаданные
  homepageSize: number
  sampleUrls: string[] // 5-10 URL, на которых тестировали парсинг
}

// ============================================================================
// PRICE STRATEGY — стратегии извлечения цен (раздел 2.3)
// ============================================================================

export type PriceStrategyName =
  | 'schema_org' // #1 — Schema.org microdata (эталон, CMD)
  | 'data_attributes' // #2 — data-eec-* / data-price (Gemotest)
  | 'embedded_json' // #3 — JSON state в HTML (Helix)
  | 'css_class' // #4 — CSS-классы с 'price' (Veramed, Altamed+)
  | 'seo_text_block' // #5 — SEO-блок с минимальными ценами (Medsi)
  | 'vlm_screenshot' // #6 — VLM fallback (T8)

export interface PriceStrategy {
  name: PriceStrategyName
  priority: number // 1-99, меньше = выше приоритет
  regex?: RegExp // для regex-based стратегий
  selectorCandidates?: string[] // для CSS-based
  description?: string
  cost: 'free' | 'low' | 'high'
}

export interface PriceStrategyTest {
  strategy: PriceStrategyName
  attempted: boolean
  success: boolean
  itemsExtracted: number
  sampleUrls: string[]
  confidence: number // 0-100
  error?: string
}

// ============================================================================
// UNIVERSAL PRICE ITEM — единая модель данных (раздел 6)
// ============================================================================

export type ExternalIdType =
  | 'cat_id' // Gemotest: cat-NNNN
  | 'hxid' // Helix: 02-005
  | 'code' // CMD: 100002
  | 'slug' // Altamed+: URL slug
  | 'name_hash' // Veramed: hash(normalized name)

export interface UniversalPriceItem {
  // === Идентификация ===
  externalId: string
  externalIdType: ExternalIdType
  code?: string
  slug?: string

  // === Содержание ===
  name: string // canonical (после normalize)
  nameRaw: string // как на сайте
  category?: string
  section?: string
  description?: string
  biomaterial?: string
  estimatedDays?: string
  method?: string

  // === Цена ===
  price: number // в копейках (Int для SQLite)
  priceRaw: string // "1 300 ₽", "от 530 р."
  currency: string // ISO 4217: RUB
  isMinPrice: boolean // true если "от X"
  marketPrice?: number // старая цена (в копейках)

  // === Scope ===
  region: string
  locationKey?: string
  tariff?: string

  // === Metadata ===
  url: string
  available: boolean
  bonuses?: number
  parseStrategy: PriceStrategyName
  parseConfidence: number // 0-100
}

// ============================================================================
// DISCOVERY — результаты поиска URL с ценами (раздел 3)
// ============================================================================

export type UrlCategory =
  | 'catalog'
  | 'service'
  | 'clinic'
  | 'doctor'
  | 'article'
  | 'other'

export interface DiscoveredUrl {
  url: string
  category: UrlCategory
  hasCitySegment: boolean
  depth: number
  expected?: boolean | 'uncertain' // есть ли цена на странице
}

// ============================================================================
// SCRAPE HEALTH — метрики здоровья парсера (раздел 5.1)
// ============================================================================

export interface ScrapeHealth {
  itemsExtracted: number
  expectedMin: number
  nullFieldsRate: number
  htmlStructureHash: string
  structureDiff: number
}

export type HealthAction =
  | 'proceed'
  | 'proceed_with_warning'
  | 'trigger_reprobe'
  | 'trigger_partial_reprobe'
  | 'pause_competitor'

export interface HealthEvaluation {
  action: HealthAction
  reason?: string
}

// ============================================================================
// FETCH RESULT — результат HTTP-запроса
// ============================================================================

export interface FetchResult {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  contentHash: string // sha256
  fetchedAt: Date
  durationMs: number
  tier: Tier
  retries: number
  proxyUsed?: string
  fromCache: boolean
  rawLakeKey?: string
}

// ============================================================================
// VALIDATION
// ============================================================================

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  itemsValid: number
  itemsInvalid: number
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const TIER_LABELS: Record<Tier, string> = {
  T1: 'Static HTML (server-rendered)',
  T1_schema_org: 'Static HTML + Schema.org microdata (gold standard)',
  T2: 'SSR + embedded JSON state',
  T3: 'SPA + JSON API',
  T4: 'SPA without API (Playwright)',
  T5: 'Lazy-loaded / infinite scroll',
  T6: 'Light antibot (Cloudflare)',
  T7: 'Heavy antibot (Datadome/PerimeterX)',
  T8: 'Visual / image-based (VLM)',
  T9: 'PDF/DOCX/XLSX price list',
  T10: 'Web services (Telegram bots)',
}

export const REGION_STRATEGY_LABELS: Record<RegionStrategyType, string> = {
  url_prefix: 'URL prefix (/{city}/...)',
  url_path_segment: 'URL path segment (/catalog/{city}/...)',
  url_subdomain: 'Subdomain ({city}.example.ru)',
  url_query: 'Query parameter (?clinic={slug})',
  cookie: 'Cookie-based (Cookie: cityId={id})',
  ip_default: 'IP-based SSR (requires proxy)',
  tariff_select: 'Tariff tabs in HTML',
  none: 'No region binding (single location)',
}
