/**
 * Test script: robots.txt + sitemap fetching для cmd-online.ru.
 *
 * Запуск (вручную, не запускается автоматически):
 *   bun run src/scraper/strategies/__test__/robots-sitemap-test.ts
 *
 * Что делает:
 * 1. Fetch robots.txt для https://www.cmd-online.ru
 * 2. Извлекает sitemap URLs (поле Sitemap: в robots.txt)
 * 3. Логирует disallow-правила и crawl-delay
 * 4. Fetch первого sitemap (maxUrls=500 — чтобы не загружать все sub-sitemap,
 *    достаточно для оценки структуры URL)
 * 5. Категоризирует найденные URL по path patterns (методология раздел 3.4)
 *
 * Примечание: в probe-mode (когда нужно лишь понять структуру сайта) лимит
 * maxUrls=500 приемлем. Полный сбор всех URL будет в Phase 2 (Discovery Engine).
 */

import { fetchAndParseRobots } from '@/scraper/strategies/robots-fetcher'
import { fetchSitemap } from '@/scraper/strategies/sitemap-fetcher'
import { logger } from '@/lib/logger'

const log = logger.child({ module: 'robots-sitemap-test' })

const BASE_URL = 'https://www.cmd-online.ru'

/**
 * Упрощённая классификация URL по path patterns (методология раздел 3.4).
 */
function classifyUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    if (/\/(services|uslugi|cure|vectors)\//.test(path)) return 'service'
    if (/\/(catalog|katalog|analizy)\//.test(path)) return 'catalog'
    if (/\/(clinics|filialy|branches)\//.test(path)) return 'clinic'
    if (/\/(doctors|vrachi|specialists)\//.test(path)) return 'doctor'
    if (/\/(articles|blog|news|press)\//.test(path)) return 'article'
    return 'other'
  } catch {
    return 'invalid'
  }
}

async function main(): Promise<void> {
  log.info({ baseUrl: BASE_URL }, '=== Step 1: Fetch robots.txt ===')

  const robots = await fetchAndParseRobots(BASE_URL)
  if (!robots) {
    log.warn('robots.txt не найден — завершаем')
    return
  }

  log.info(
    {
      sitemaps: robots.sitemaps,
      disallowCount: robots.disallow.length,
      allowCount: robots.allow.length,
      crawlDelay: robots.crawlDelay,
    },
    'robots.txt parsed'
  )
  log.debug({ rawHead: robots.raw.slice(0, 1500) }, 'robots.txt raw (first 1500 chars)')

  if (robots.sitemaps.length === 0) {
    log.warn('Sitemap URLs не найдены в robots.txt — завершаем')
    return
  }

  const firstSitemap = robots.sitemaps[0]
  log.info({ sitemap: firstSitemap }, '=== Step 2: Fetch first sitemap (maxUrls=500) ===')

  // maxUrls=500: для теста достаточно увидеть структуру URL. Если первый
  // sitemap — это sitemapindex, fetchSitemap рекурсивно зайдёт в sub-sitemap
  // (до 5 параллельно), но остановится на 500 URL.
  const urls = await fetchSitemap(firstSitemap, {
    maxUrls: 500,
    timeoutMs: 30000,
    onProgress: (count, currentUrl) => {
      if (count % 100 === 0) log.info({ count, currentUrl }, 'progress')
    },
  })

  log.info({ totalUrls: urls.length }, '=== Step 3: Results ===')
  log.info({ sample: urls.slice(0, 10) }, 'First 10 URLs with metadata')

  // Категоризация по path patterns
  const byCategory: Record<string, number> = {}
  for (const u of urls) {
    const cat = classifyUrl(u.url)
    byCategory[cat] = (byCategory[cat] || 0) + 1
  }
  log.info({ byCategory }, 'URL categories breakdown')

  log.info('=== Test complete ===')
}

main().catch((e) => {
  log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'Test failed')
  process.exit(1)
})
