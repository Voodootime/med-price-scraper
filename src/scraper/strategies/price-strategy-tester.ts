/**
 * Price Strategy Tester — тестирование 5 стратегий извлечения цен на HTML.
 *
 * Для каждого sample HTML проверяет каждую из 5 стратегий (раздел 2.3 методологии):
 * 1. schema_org       — Schema.org микроразметка (itemprop="price")
 * 2. data_attributes  — data-eec-price / data-price атрибуты
 * 3. embedded_json    — встроенный JSON state (__NEXT_DATA__, G.json./api/)
 * 4. css_class        — элементы с class*="price" (через cheerio)
 * 5. seo_text_block   — SEO-блок "Услуги: ... - X руб."
 *
 * Каждая стратегия получает:
 * - attempted = true (пробовали)
 * - success = itemsExtracted >= 3
 * - confidence = min(100, itemsExtracted * 10)
 *
 * Документация: docs/scraping-methodology.md раздел 2.3
 */

import * as cheerio from 'cheerio'
import { logger } from '@/lib/logger'
import type { PriceStrategyName, PriceStrategyTest } from '@/scraper/types'

const log = logger.child({ module: 'price-strategy-tester' })

/** Опции тестирования стратегий. */
export interface PriceStrategyTesterOptions {
  /** URL'ы, соответствующие sample HTML (для отчёта) */
  sampleUrls: string[]
  /** Уже загруженные HTML — каждый соответствует sampleUrls[i] */
  sampleHtmls: string[]
}

/** Минимальное число извлечённых цен, чтобы стратегия считалась успешной. */
const SUCCESS_THRESHOLD = 3

/**
 * Тестировать все 5 стратегий извлечения цен на предоставленных HTML.
 *
 * @param options.sampleUrls - URL'ы для отчёта (длина = sampleHtmls.length)
 * @param options.sampleHtmls - HTML страницы для тестирования
 * @returns массив PriceStrategyTest по одной записи на стратегию
 *
 * @example
 * const results = await testPriceStrategies({
 *   sampleUrls: ['https://example.ru/catalog'],
 *   sampleHtmls: [htmlString],
 * })
 * const best = results.find(r => r.success && r.confidence === Math.max(...results.map(r => r.confidence)))
 */
export async function testPriceStrategies(
  options: PriceStrategyTesterOptions
): Promise<PriceStrategyTest[]> {
  const { sampleUrls, sampleHtmls } = options

  if (sampleUrls.length !== sampleHtmls.length) {
    throw new Error(
      `sampleUrls.length (${sampleUrls.length}) must equal sampleHtmls.length (${sampleHtmls.length})`
    )
  }

  const strategies: PriceStrategyName[] = [
    'schema_org',
    'data_attributes',
    'embedded_json',
    'css_class',
    'seo_text_block',
  ]

  const results: PriceStrategyTest[] = strategies.map((strategy) => {
    let totalItems = 0
    const matchedUrls: string[] = []

    for (let i = 0; i < sampleHtmls.length; i++) {
      const html = sampleHtmls[i]
      const url = sampleUrls[i]
      let count = 0
      try {
        count = countMatches(strategy, html)
      } catch (e) {
        log.warn({ strategy, url, err: (e as Error).message }, 'strategy threw — treating as 0')
      }
      if (count > 0) {
        totalItems += count
        matchedUrls.push(url)
      }
    }

    const success = totalItems >= SUCCESS_THRESHOLD
    const confidence = Math.min(100, totalItems * 10)

    log.debug({ strategy, totalItems, matchedUrls, success, confidence }, 'strategy tested')

    return {
      strategy,
      attempted: true,
      success,
      itemsExtracted: totalItems,
      sampleUrls: matchedUrls,
      confidence,
    }
  })

  log.info(
    {
      summary: results.map((r) => ({ strategy: r.strategy, items: r.itemsExtracted, ok: r.success })),
    },
    'All price strategies tested'
  )

  return results
}

/**
 * Посчитать число матчей для конкретной стратегии на одном HTML.
 * Каждая стратегия использует свой regex/selector (раздел 2.3 методологии).
 */
function countMatches(strategy: PriceStrategyName, html: string): number {
  switch (strategy) {
    case 'schema_org': {
      const regex = /<span[^>]*itemprop=["']price["'][^>]*>([^<]+)<\/span>/gi
      return countRegexMatches(regex, html)
    }
    case 'data_attributes': {
      const regex = /data-(?:eec-)?price=["']([^"']+)["']/gi
      return countRegexMatches(regex, html)
    }
    case 'embedded_json': {
      // Helix: "G.json./api/...":{"body":{ — считаем количество таких ключей
      const helixRegex = /"G\.json\.\/api\/[^"]+"\s*:\s*\{"body":\{/g
      const helixCount = countRegexMatches(helixRegex, html)
      // Next.js: __NEXT_DATA__ script — если есть, считаем за 1 потенциальный blob
      const nextRegex = /<script[^>]+id="__NEXT_DATA__"[^>]*>/i
      const nextCount = nextRegex.test(html) ? 1 : 0
      return helixCount + nextCount
    }
    case 'css_class': {
      const $ = cheerio.load(html)
      // Любой элемент с class, содержащим "price" (case-insensitive)
      let total = 0
      $('[class]').each((_i, el) => {
        const cls = $(el).attr('class') ?? ''
        if (/price/i.test(cls)) total++
      })
      return total
    }
    case 'seo_text_block': {
      // Сначала найти SEO-блок "Услуги: ... </p>"
      const blockRegex = /(?:Прием специалиста|Услуги|Описание услуг)[:\s]*([\s\S]+?)<\/p>/gi
      let total = 0
      let blockMatch: RegExpExecArray | null
      while ((blockMatch = blockRegex.exec(html)) !== null) {
        const block = blockMatch[1]
        // Внутри блока ищем item pattern "Услуга - X руб."
        const itemRegex = /([^.]+?)\s*-\s*(?:от\s+)?(\d[\d\s]*)\s*руб\./gi
        let itemMatch: RegExpExecArray | null
        while ((itemMatch = itemRegex.exec(block)) !== null) {
          total++
        }
      }
      return total
    }
    default:
      return 0
  }
}

/**
 * Посчитать число матчей regex с global flag (без аллокации массива).
 */
function countRegexMatches(regex: RegExp, text: string): number {
  if (!regex.global) {
    throw new Error(`Regex must have global flag: ${regex.source}`)
  }
  let count = 0
  while (true) {
    const m = regex.exec(text)
    if (m === null) break
    count++
    // Защита от zero-length match (хотя для наших regex unlikely)
    if (m.index === regex.lastIndex) regex.lastIndex++
  }
  // Сброс lastIndex для переиспользуемых regex
  regex.lastIndex = 0
  return count
}
