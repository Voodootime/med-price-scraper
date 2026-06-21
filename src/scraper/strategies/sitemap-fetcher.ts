/**
 * Sitemap fetcher — рекурсивный парсер sitemap.xml с поддержкой sitemapindex.
 *
 * Возможности:
 * - `<sitemapindex>` — рекурсивный спуск в sub-sitemap (параллельно, до 5)
 * - `<urlset>` — извлечение `<loc>`, `<lastmod>`, `<changefreq>`, `<priority>`
 * - gzip (.xml.gz) — распаковка через `node:zlib`
 * - maxUrls limit — защита от OOM на гигантских sitemap (cmd-online.ru = 1510 URL)
 * - onProgress callback для логирования прогресса
 * - Regex-fallback, если linkedom не смог распарсить XML
 *
 * Обработка ошибок: timeout / 404 / invalid XML — НЕ падаем, возвращаем пустой массив.
 *
 * Документация: docs/scraping-methodology.md раздел 3.2 (Sitemap discovery)
 */

import { DOMParser } from 'linkedom'
import { logger } from '@/lib/logger'
import { fetchPublicHttpUrl } from '@/lib/security/url-policy'
import { getStaticFetcher } from '@/scraper/strategies/static-fetcher'

const log = logger.child({ module: 'sitemap-fetcher' })

export interface SitemapUrl {
  url: string
  lastmod?: string
  changefreq?: string
  priority?: number
}

export interface FetchSitemapOptions {
  /** Максимум URL для извлечения (default 100000) — защита от OOM */
  maxUrls?: number
  /** Timeout на один HTTP-запрос (default 30000ms) */
  timeoutMs?: number
  /** Callback прогресса: (count, currentUrl) — для логирования */
  onProgress?: (count: number, currentUrl: string) => void
}

/** Конкурентность для параллельной загрузки sub-sitemap из sitemapindex */
const CONCURRENCY = 5

/** Максимальная глубина рекурсии (sitemapindex → sitemapindex → ...) */
const MAX_DEPTH = 5

/**
 * Декомпрессия gzip-контента (.xml.gz файлов).
 * Возвращает пустую строку при ошибке — не падать.
 */
async function decompressGzip(buffer: ArrayBuffer): Promise<string> {
  try {
    const { gunzipSync } = await import('node:zlib')
    return gunzipSync(Buffer.from(buffer)).toString('utf-8')
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'gunzip failed')
    return ''
  }
}

/**
 * Низкоуровневый fetch sitemap-файла. Для .gz — fetch + gunzip; для .xml —
 * через StaticFetcher (retry, UA-ротация, content-hash).
 */
async function fetchContent(sitemapUrl: string, timeoutMs: number): Promise<string> {
  if (sitemapUrl.endsWith('.gz')) {
    try {
      const resp = await fetchPublicHttpUrl(sitemapUrl, {
        headers: { Accept: 'application/gzip, application/xml' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!resp.ok) {
        log.warn({ status: resp.status, sitemapUrl }, 'gzip sitemap non-OK status')
        return ''
      }
      return decompressGzip(await resp.arrayBuffer())
    } catch (e) {
      log.warn({ err: (e as Error).message, sitemapUrl }, 'gzip sitemap fetch failed')
      return ''
    }
  }
  try {
    const r = await getStaticFetcher().fetch({
      url: sitemapUrl,
      region: '',
      tier: 'T1',
      timeoutMs,
      retries: 1,
      rateLimitMs: 0,
    })
    return r.status < 400 ? r.body : ''
  } catch (e) {
    log.warn({ err: (e as Error).message, sitemapUrl }, 'sitemap fetch failed')
    return ''
  }
}

/**
 * Парсинг XML sitemap. Сначала linkedom, при ошибке — regex-fallback
 * (для sitemap этого достаточно: структура простая и хорошо структурирована).
 */
function parseXml(xml: string): { isIndex: boolean; sitemaps: string[]; urls: SitemapUrl[] } {
  if (!xml?.trim()) return { isIndex: false, sitemaps: [], urls: [] }

  // --- linkedom (основной путь) ---
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    if (doc.querySelector('sitemapindex') !== null) {
      const sm: string[] = []
      doc.querySelectorAll('sitemap > loc').forEach((n) => {
        const t = n.textContent?.trim()
        if (t) sm.push(t)
      })
      return { isIndex: true, sitemaps: sm, urls: [] }
    }
    const urls: SitemapUrl[] = []
    doc.querySelectorAll('url').forEach((n) => {
      const loc = n.querySelector('loc')?.textContent?.trim()
      if (!loc) return
      const pStr = n.querySelector('priority')?.textContent?.trim()
      const p = pStr ? parseFloat(pStr) : NaN
      urls.push({
        url: loc,
        lastmod: n.querySelector('lastmod')?.textContent?.trim() || undefined,
        changefreq: n.querySelector('changefreq')?.textContent?.trim() || undefined,
        priority: isNaN(p) ? undefined : p,
      })
    })
    return { isIndex: false, sitemaps: [], urls }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'linkedom parse failed, using regex fallback')
  }

  // --- regex fallback ---
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const sitemaps = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim())
    return { isIndex: true, sitemaps, urls: [] }
  }
  const urls: SitemapUrl[] = []
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const c = block[1]
    const loc = c.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]?.trim()
    if (!loc) continue
    const pStr = c.match(/<priority>\s*([^<]+?)\s*<\/priority>/i)?.[1]?.trim()
    const p = pStr ? parseFloat(pStr) : NaN
    urls.push({
      url: loc,
      lastmod: c.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim() || undefined,
      changefreq: c.match(/<changefreq>\s*([^<]+?)\s*<\/changefreq>/i)?.[1]?.trim() || undefined,
      priority: isNaN(p) ? undefined : p,
    })
  }
  return { isIndex: false, sitemaps: [], urls }
}

/**
 * Пул задач с ограничением параллелизма (без внешних зависимостей).
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0
  const run = async () => {
    while (idx < items.length) await worker(items[idx++])
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
}

/**
 * Рекурсивно загрузить и распарсить sitemap.
 *
 * Поддерживает:
 * - `<sitemapindex>` — рекурсивный спуск в sub-sitemap (до 5 одновременно)
 * - `<urlset>` — извлечение всех `<url>` с метаданными
 * - gzip (.xml.gz) — автоматическая распаковка
 * - Ограничение `maxUrls` для предотвращения OOM
 *
 * @param sitemapUrl — URL sitemap-файла (sitemap.xml, sitemap_index.xml, .xml.gz)
 * @param options.maxUrls — максимум URL для извлечения (default 100000)
 * @param options.timeoutMs — timeout на один HTTP-запрос (default 30000ms)
 * @param options.onProgress — callback прогресса `(count, currentUrl)`
 * @returns массив `SitemapUrl` (пустой массив при ошибке — НЕ бросает)
 *
 * @example
 * const urls = await fetchSitemap('https://example.com/sitemap.xml', {
 *   maxUrls: 50000,
 *   onProgress: (n, url) => console.log(`[${n}] ${url}`),
 * })
 */
export async function fetchSitemap(
  sitemapUrl: string,
  options: FetchSitemapOptions = {}
): Promise<SitemapUrl[]> {
  const maxUrls = options.maxUrls ?? 100000
  const timeoutMs = options.timeoutMs ?? 30000
  const onProgress = options.onProgress
  const collected: SitemapUrl[] = []
  const visited = new Set<string>()

  async function process(url: string, depth: number): Promise<void> {
    if (visited.has(url) || depth > MAX_DEPTH || collected.length >= maxUrls) return
    visited.add(url)

    log.debug({ url, depth, collected: collected.length }, 'Processing sitemap')
    const xml = await fetchContent(url, timeoutMs)
    if (!xml) return

    const parsed = parseXml(xml)

    if (parsed.isIndex) {
      log.info({ url, subSitemaps: parsed.sitemaps.length }, 'sitemapindex found, recursing')
      await runPool(parsed.sitemaps, CONCURRENCY, (sub) => process(sub, depth + 1))
      return
    }

    for (const u of parsed.urls) {
      if (collected.length >= maxUrls) {
        log.warn({ maxUrls, url }, 'maxUrls reached, truncating')
        break
      }
      collected.push(u)
      if (onProgress && collected.length % 500 === 0) onProgress(collected.length, u.url)
    }
    if (onProgress) onProgress(collected.length, url)
  }

  await process(sitemapUrl, 0)
  log.info({ sitemapUrl, totalUrls: collected.length }, 'Sitemap fetch complete')
  return collected
}
