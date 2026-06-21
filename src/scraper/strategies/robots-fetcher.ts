/**
 * Robots.txt parser — извлекает sitemap URLs, disallow/allow правила и crawl-delay.
 *
 * Использует `robots-parser` для RFC-совместимого разбора и `StaticFetcher`
 * для HTTP-запроса (retry, UA rotation, timeout).
 *
 * Поведение:
 * - 404 / 4xx / 5xx → вернуть null (считаем, что можно всё, либо сайт недоступен)
 * - 200 → распарсить через robots-parser + ручной разбор disallow/allow
 * - Network error → вернуть null (не падать)
 *
 * Документация: docs/scraping-methodology.md
 *   раздел 2.1 (Probe pipeline — robots.txt анализ)
 *   раздел 3.2 (Sitemap discovery — берём sitemap URLs из robots.txt)
 */

import robotsParser from 'robots-parser'
import { logger } from '@/lib/logger'
import { getStaticFetcher } from '@/scraper/strategies/static-fetcher'

const log = logger.child({ module: 'robots-fetcher' })

export interface ParsedRobots {
  /** Sitemap URLs, объявленные в robots.txt (поле Sitemap:) */
  sitemaps: string[]
  /** Disallow-правила для User-agent: * */
  disallow: string[]
  /** Allow-правила для User-agent: * */
  allow: string[]
  /** Crawl-delay в секундах, если указан для User-agent: * */
  crawlDelay?: number
  /** Сырой текст robots.txt (для отладки и audit) */
  raw: string
}

/**
 * Нормализовать baseUrl — оставить только origin (protocol + host[:port]).
 * Защита от trailing slash / path / query в переданном URL.
 */
function normalizeBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return `${u.protocol}//${u.host}`
  } catch {
    return baseUrl.replace(/\/$/, '')
  }
}

/**
 * Разобрать disallow/allow правила для User-agent: * из raw robots.txt.
 *
 * `robots-parser` не экспортирует raw rules, поэтому парсим вручную.
 * Поддерживает два распространённых формата:
 *
 *   1. Один агент — один блок правил:
 *      ```
 *      User-agent: *
 *      Disallow: /admin
 *
 *      User-agent: Googlebot
 *      Disallow: /search
 *      ```
 *
 *   2. Несколько агентов — общий блок правил:
 *      ```
 *      User-agent: *
 *      User-agent: BadBot
 *      Disallow: /admin
 *      ```
 */
function parseRulesForAllAgents(raw: string): { disallow: string[]; allow: string[] } {
  const disallow: string[] = []
  const allow: string[] = []
  let currentAgents = new Set<string>()
  let inRuleSection = false // true после первой Disallow/Allow-строки в текущем блоке

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // Убираем inline-комментарии
    const hash = trimmed.indexOf('#')
    const cleaned = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).trim()
    const colon = cleaned.indexOf(':')
    if (colon < 0) continue

    const field = cleaned.slice(0, colon).trim().toLowerCase()
    const value = cleaned.slice(colon + 1).trim()

    if (field === 'user-agent') {
      // Новая User-agent строка после правил — начинает новый блок
      if (inRuleSection) {
        currentAgents = new Set()
        inRuleSection = false
      }
      currentAgents.add(value)
      continue
    }

    if (field === 'disallow' || field === 'allow') {
      inRuleSection = true
      if (!value) continue // пустой Disallow = "разрешить всё"
      if (currentAgents.has('*')) {
        if (field === 'disallow') disallow.push(value)
        else allow.push(value)
      }
    }
    // Sitemap и Crawl-delay обрабатываются через robots-parser
  }

  return { disallow, allow }
}

/**
 * Загрузить и распарсить robots.txt для сайта.
 *
 * @param baseUrl — базовый URL сайта (например, `https://www.cmd-online.ru`).
 *                  Path/query игнорируются — берётся только origin.
 * @returns `ParsedRobots` со всеми sitemap/disallow/allow/crawl-delay, либо
 *          `null`, если robots.txt отсутствует (404), вернул ошибку, или
 *          запрос упал с network error (не падать — см. требования).
 *
 * @example
 * const robots = await fetchAndParseRobots('https://www.cmd-online.ru')
 * if (robots) {
 *   console.log(robots.sitemaps)   // ['https://www.cmd-online.ru/sitemap.xml']
 *   console.log(robots.disallow)  // ['/admin/', '/cart/']
 *   console.log(robots.crawlDelay) // 1
 * }
 */
export async function fetchAndParseRobots(baseUrl: string): Promise<ParsedRobots | null> {
  const origin = normalizeBaseUrl(baseUrl)
  const robotsUrl = `${origin}/robots.txt`
  log.info({ robotsUrl }, 'Fetching robots.txt')

  const fetcher = getStaticFetcher()

  let result
  try {
    result = await fetcher.fetch({
      url: robotsUrl,
      region: '',
      tier: 'T1',
      timeoutMs: 15000,
      retries: 1,
      rateLimitMs: 0,
    })
  } catch (e) {
    log.warn({ err: (e as Error).message, robotsUrl }, 'Failed to fetch robots.txt')
    return null
  }

  // 404 / 4xx / 5xx → нет robots.txt (или сервер недоступен)
  if (result.status === 404) {
    log.info({ robotsUrl }, 'robots.txt not found (404) — everything allowed by default')
    return null
  }
  if (result.status >= 400) {
    log.warn({ status: result.status, robotsUrl }, 'robots.txt returned error status')
    return null
  }

  const raw = result.body
  const parser = robotsParser(robotsUrl, raw)

  const sitemaps = parser.getSitemaps()
  const crawlDelay = parser.getCrawlDelay('*') ?? undefined
  const { disallow, allow } = parseRulesForAllAgents(raw)

  log.info(
    { sitemaps: sitemaps.length, disallow: disallow.length, allow: allow.length, crawlDelay },
    'robots.txt parsed'
  )

  return { sitemaps, disallow, allow, crawlDelay, raw }
}
