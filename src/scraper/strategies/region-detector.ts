/**
 * Region Strategy Detector — определяет, как сайт привязывает цены к региону.
 *
 * 8 типов стратегий (раздел 0.4.1 методологии):
 * - url_prefix: /{city}/catalog/...  (Gemotest)
 * - url_path_segment: /catalog/{city}/{slug}/  (CMD)
 * - url_subdomain: https://{city}.medsi.ru/  (Medsi)
 * - url_query: /services/x/?clinic={slug}  (Medsi clinics)
 * - cookie: Cookie: cityId={id}  (Helix)
 * - ip_default: SSR определяет по IP  (Helix)
 * - tariff_select: Вкладка тарифа в HTML  (Veramed)
 * - none: Регион не влияет  (Altamed+)
 *
 * Документация: docs/scraping-methodology.md раздел 2.5
 */

import { logger } from '@/lib/logger'
import type { RegionStrategy, RegionStrategyType } from '@/scraper/types'
import { KNOWN_CITY_SLUGS } from '@/scraper/utils/city-slugs'

export interface RegionDetectionInput {
  /** URL главной страницы */
  baseUrl: string
  /** HTML главной страницы (для tariff_select) */
  homepageHtml: string
  /** Все URL из sitemap (для url_prefix, url_path_segment) */
  sitemapUrls: string[]
  /** Поддомены (если найдены) */
  subdomains?: string[]
}

export interface RegionDetectionResult {
  strategy: RegionStrategy
  reasoning: string
  candidates: string[] // потенциальные значения региона
  confidence: number // 0-100
}

/**
 * Определить стратегию привязки региона.
 *
 * Алгоритм проверяет стратегии в порядке приоритета:
 * 1. url_path_segment — slug города в середине URL (CMD)
 * 2. url_prefix — /{city}/... в начале (Gemotest)
 * 3. url_subdomain — {city}.example.ru (Medsi)
 * 4. tariff_select — табы тарифов в HTML (Veramed)
 * 5. none — регион не влияет (Altamed+)
 *
 * cookie и ip_default требуют runtime-тестирования и определяются отдельно.
 */
export function detectRegionStrategy(
  input: RegionDetectionInput
): RegionDetectionResult {
  const log = logger.child({ module: 'region-detector', baseUrl: input.baseUrl })

  // #1 — url_path_segment: ищем slug'ы городов в середине URL
  const segmentCandidates = findCitySlugsInPathSegments(input.sitemapUrls)
  if (segmentCandidates.length >= 3) {
    const strategy: RegionStrategy = {
      type: 'url_path_segment',
      param: 'city_slug',
      mapping: buildMapping(segmentCandidates),
      note: `Обнаружено ${segmentCandidates.length} городов в path-сегментах URL`,
    }
    log.info(
      { strategy: strategy.type, candidates: segmentCandidates.slice(0, 5) },
      'Region strategy detected'
    )
    return {
      strategy,
      reasoning: `Найдено ${segmentCandidates.length} уникальных slug'ов городов в path-сегментах URL (например /catalog/{city}/{slug}/)`,
      candidates: segmentCandidates,
      confidence: 90,
    }
  }

  // #2 — url_prefix: /{city}/... в начале пути
  const prefixCandidates = findCityPrefixes(input.sitemapUrls)
  if (prefixCandidates.length >= 3) {
    const strategy: RegionStrategy = {
      type: 'url_prefix',
      param: 'city_slug',
      mapping: buildMapping(prefixCandidates),
      note: `Обнаружено ${prefixCandidates.length} городов в prefix-сегментах URL`,
    }
    log.info(
      { strategy: strategy.type, candidates: prefixCandidates.slice(0, 5) },
      'Region strategy detected'
    )
    return {
      strategy,
      reasoning: `Найдено ${prefixCandidates.length} городов в начале URL (/{city}/...)`,
      candidates: prefixCandidates,
      confidence: 85,
    }
  }

  // #3 — url_subdomain: {city}.example.ru
  if (input.subdomains && input.subdomains.length >= 2) {
    const citySubdomains = input.subdomains.filter((s) => {
      const sub = s.split('.')[0].toLowerCase()
      return KNOWN_CITY_SLUGS.has(sub)
    })
    if (citySubdomains.length >= 2) {
      const strategy: RegionStrategy = {
        type: 'url_subdomain',
        param: 'subdomain',
        mapping: buildMapping(citySubdomains.map((s) => s.split('.')[0])),
        note: `Обнаружено ${citySubdomains.length} городов-поддоменов`,
      }
      log.info({ strategy: strategy.type, candidates: citySubdomains }, 'Region strategy detected')
      return {
        strategy,
        reasoning: `Найдено ${citySubdomains.length} поддоменов городов`,
        candidates: citySubdomains,
        confidence: 80,
      }
    }
  }

  // #4 — tariff_select: табы тарифов в HTML
  if (hasTariffTabs(input.homepageHtml)) {
    const tariffs = extractTariffNames(input.homepageHtml)
    const strategy: RegionStrategy = {
      type: 'tariff_select',
      param: 'tariff',
      mapping: Object.fromEntries(tariffs.map((t) => [t, t])),
      note: `Обнаружено ${tariffs.length} тарифных табов в HTML`,
    }
    log.info({ strategy: strategy.type, tariffs }, 'Region strategy detected')
    return {
      strategy,
      reasoning: `В HTML найдены тарифные табы: ${tariffs.join(', ')}`,
      candidates: tariffs,
      confidence: 75,
    }
  }

  // #5 — none (по умолчанию)
  const strategy: RegionStrategy = {
    type: 'none',
    mapping: {},
    note: 'Регион не влияет на URL/HTML — возможно одна локация или IP/cookie-based гео',
  }
  log.info({ strategy: strategy.type }, 'Region strategy detected (default)')
  return {
    strategy,
    reasoning:
      'Явных признаков привязки к региону не найдено. Сайт либо локальный, либо использует cookie/IP-geolocation (требует runtime-теста).',
    candidates: [],
    confidence: 40,
  }
}

/**
 * Найти slug'ы городов в path-сегментах URL (не в начале).
 * Пример: /catalog/msk/gluten/ → 'msk'
 */
function findCitySlugsInPathSegments(urls: string[]): string[] {
  const candidates = new Set<string>()

  for (const url of urls.slice(0, 1000)) {
    // Лимит для скорости
    try {
      const u = new URL(url)
      const segments = u.pathname.split('/').filter(Boolean)
      if (segments.length < 2) continue

      // Проверяем все сегменты кроме первого (первый = раздел)
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i].toLowerCase()
        if (KNOWN_CITY_SLUGS.has(seg)) {
          candidates.add(seg)
          break // один город на URL
        }
      }
    } catch {
      // skip invalid URL
    }
  }

  return Array.from(candidates)
}

/**
 * Найти slug'ы городов в prefix-сегменте URL (первый сегмент).
 * Пример: /moskva/catalog/... → 'moskva'
 */
function findCityPrefixes(urls: string[]): string[] {
  const candidates = new Set<string>()

  for (const url of urls.slice(0, 1000)) {
    try {
      const u = new URL(url)
      const segments = u.pathname.split('/').filter(Boolean)
      if (segments.length < 2) continue

      const first = segments[0].toLowerCase()
      if (KNOWN_CITY_SLUGS.has(first)) {
        candidates.add(first)
      }
    } catch {
      // skip
    }
  }

  return Array.from(candidates)
}

/**
 * Проверить наличие тарифных табов в HTML.
 * Признаки: data-id с названиями тарифов, классы tab с реальными названиями.
 */
function hasTariffTabs(html: string): boolean {
  // Veramed: data-id="премиум|одинцово|звенигород"
  const tariffPattern = /data-id=["'](премиум|одинцово|звенигород|москва|спб|екб|nsk|kzn)["']/i
  if (tariffPattern.test(html)) return true

  // Общий паттерн: tab + список регионов
  const tabRegionPattern = /class=["'][^"']*tab[^"']*["'][^>]*>(москва|санкт-петербург|новосибирск|екатеринбург)/i
  return tabRegionPattern.test(html)
}

/**
 * Извлечь названия тарифов из HTML.
 */
function extractTariffNames(html: string): string[] {
  const matches = new Set<string>()

  // Veramed: data-id="премиум" etc
  const regex = /data-id=["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(html)) !== null) {
    const val = m[1].toLowerCase().trim()
    if (val.length > 1 && val.length < 30) {
      matches.add(val)
    }
  }

  return Array.from(matches)
}

/**
 * Построить mapping для RegionStrategy из списка кандидатов.
 * Для известных регионов используем человеко-читаемые имена.
 */
function buildMapping(candidates: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}

  // Если есть msk/moskva — это Москва
  if (candidates.includes('msk') || candidates.includes('moskva')) {
    mapping.moscow = candidates.includes('msk') ? 'msk' : 'moskva'
    mapping.mo = mapping.moscow // Московская область использует тот же slug
  }

  // Если есть spb — это СПб
  if (candidates.includes('spb') || candidates.includes('sankt-peterburg')) {
    mapping.spb = candidates.includes('spb') ? 'spb' : 'sankt-peterburg'
  }

  return mapping
}
