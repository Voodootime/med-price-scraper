/**
 * Test script: framework detection + price strategy testing на 3 синтетических HTML.
 *
 * Запуск (вручную, не запускается автоматически):
 *   bun run src/scraper/strategies/__test__/framework-test.ts
 *
 * Что делает:
 * 1. Тестирует detectFramework на 3 HTML-фикстурах:
 *    - Битрикс (class="bx-core bx-mac", /bitrix/ asset path, ₽)
 *    - Next.js (script#__NEXT_DATA__, embedded JSON)
 *    - Angular SSR (_nghost-serverapp-..., ng-version)
 * 2. Дополнительно прогоняет testPriceStrategies на тех же HTML
 *    (для проверки, что детектор фреймворка и тестер стратегий согласованы).
 * 3. Логирует результаты.
 */

import { detectFramework } from '@/scraper/strategies/framework-detector'
import { testPriceStrategies } from '@/scraper/strategies/price-strategy-tester'
import { logger } from '@/lib/logger'

const log = logger.child({ module: 'framework-test' })

// ============================================================================
// Test fixtures — синтетические HTML, имитирующие разные фреймворки
// ============================================================================

const bitrixFixture = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Клиника — Услуги и цены</title>
  <link rel="stylesheet" href="/bitrix/templates/main/style.css">
  <script src="/bitrix/js/main/core/core.js"></script>
</head>
<body class="bx-core bx-mac">
  <div class="bx-layout">
    <h1>Услуги клиники</h1>
    <div class="bx-system-tabs">
      <div class="price-list">
        <span itemprop="price">1 300 ₽</span>
        <meta itemprop="priceCurrency" content="RUB">
        <span itemprop="price">2 500 ₽</span>
        <span itemprop="price">530 р.</span>
        <span itemprop="price">3 000 руб.</span>
        <span itemprop="price">6 800 ₽</span>
      </div>
    </div>
    <a href="/bitrix/catalog/">Каталог</a>
  </div>
</body>
</html>`

const nextFixture = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Медицинские услуги</title>
</head>
<body>
  <div id="__next">
    <main>
      <h1>Анализы и цены</h1>
      <div class="catalog">
        <div data-eec-price="1300" data-eec-name="Общий анализ крови">1 300 ₽</div>
        <div data-eec-price="2500" data-eec-name="Биохимия">2 500 ₽</div>
        <div data-eec-price="530" data-eec-name="Глюкоза">530 ₽</div>
        <div data-eec-price="6800" data-eec-name="Комплекс">6 800 ₽</div>
      </div>
    </main>
  </div>
  <script id="__NEXT_DATA__" type="application/json">
    {"props":{"pageProps":{"items":[{"id":1,"price":130000},{"id":2,"price":250000}]}}}
  </script>
</body>
</html>`

const angularFixture = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>MedAngular — Прайс</title>
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <app-root ng-version="17.0.0" _nghost-serverapp-c1261994999="">
    <div _ngcontent-serverapp-c1261994999="" class="layout">
      <h1 _ngcontent-serverapp-c1261994999="">Прайс-лист клиники</h1>
      <app-price-list _ngcontent-serverapp-c1261994999="" _nghost-serverapp-c1265588777="">
        <div _ngcontent-serverapp-c1265588777="" class="price-item">
          <span class="price-value">1 300 ₽</span>
          <span class="price-value">2 500 ₽</span>
          <span class="price-value">530 ₽</span>
        </div>
      </app-price-list>
    </div>
  </app-root>
  <script>window.__INITIAL_STATE__ = {"prices":[{"id":1,"value":130000}]}</script>
</body>
</html>`

interface Fixture {
  name: string
  url: string
  html: string
  expectedFramework: string
}

const fixtures: Fixture[] = [
  {
    name: 'Bitrix (T1)',
    url: 'https://example-clinic.bitrix.ru/',
    html: bitrixFixture,
    expectedFramework: 'bitrix',
  },
  {
    name: 'Next.js (T2)',
    url: 'https://example-next.med/',
    html: nextFixture,
    expectedFramework: 'next',
  },
  {
    name: 'Angular SSR (T2)',
    url: 'https://example-angular.med/',
    html: angularFixture,
    expectedFramework: 'angular',
  },
]

/**
 * Главная точка входа тест-скрипта.
 */
async function main(): Promise<void> {
  log.info('=== Framework Detector + Price Strategy Tester — test ===')

  const allHtmls: string[] = []
  const allUrls: string[] = []

  for (const fx of fixtures) {
    log.info({ fixture: fx.name, url: fx.url, expected: fx.expectedFramework }, '--- Fixture ---')

    const result = detectFramework(fx.html)

    const matched = result.framework === fx.expectedFramework
    log.info(
      {
        framework: result.framework,
        expected: fx.expectedFramework,
        matched,
        confidence: result.confidence,
        isSSR: result.isSSR,
        hasEmbeddedState: result.hasEmbeddedState,
        hasSchemaOrg: result.hasSchemaOrg,
        currencyFormat: result.currencyFormat,
        antiBotHints: result.antiBotHints,
      },
      'detectFramework result'
    )
    log.debug({ signals: result.signals }, 'signals that fired')

    if (!matched) {
      log.warn({ got: result.framework, expected: fx.expectedFramework }, 'MISMATCH!')
    }

    allHtmls.push(fx.html)
    allUrls.push(fx.url)
  }

  log.info('=== Price strategy test (all 3 fixtures combined) ===')
  const strategyResults = await testPriceStrategies({
    sampleUrls: allUrls,
    sampleHtmls: allHtmls,
  })

  for (const r of strategyResults) {
    log.info(
      {
        strategy: r.strategy,
        items: r.itemsExtracted,
        success: r.success,
        confidence: r.confidence,
        matchedUrls: r.sampleUrls,
      },
      'strategy result'
    )
  }

  log.info('=== Test complete ===')
}

main().catch((e) => {
  log.error({ err: (e as Error).message, stack: (e as Error).stack }, 'Test failed')
  process.exit(1)
})
