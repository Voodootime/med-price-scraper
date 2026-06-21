# Task: phase-1-framework-detector

**Agent:** full-stack-developer
**Date:** 2025
**Scope:** framework detector + price strategy tester for Probe Engine (Phase 1)

## Context Reference

Перед началом работы прочитал:
- `/home/z/my-project/worklog.md` — все предыдущие фазы (Phase 0: foundation, dashboard, verification, download endpoints; Phase 1: robots-sitemap)
- `/home/z/my-project/agent-ctx/phase-1-robots-sitemap-full-stack-developer.md` — записи предыдущего агента (включая замечание о pre-existing TS error в static-fetcher.ts)
- `/home/z/my-project/docs/scraping-methodology.md` — раздел 2.2 (Framework detection heuristics) и 2.3 (Price extraction strategies)
- `/home/z/my-project/src/scraper/types/index.ts` — Framework, AntiBotHints, PriceStrategyTest, PriceStrategyName
- `/home/z/my-project/src/scraper/interfaces/index.ts` — Fetcher, FetcherOptions (для исправления импорта)
- `/home/z/my-project/src/scraper/strategies/static-fetcher.ts` — готовый StaticFetcher (с ошибкой импорта)
- `/home/z/my-project/src/lib/logger/index.ts` — pino logger + child-логгеры

## Bugfix Applied

**Файл:** `src/scraper/strategies/static-fetcher.ts`, line 17

**БЫЛО** (ошибка):
```typescript
import type { FetchResult, Fetcher, FetcherOptions, Tier } from '@/scraper/types'
```

**СТАЛО** (исправлено):
```typescript
import type { FetchResult, Tier } from '@/scraper/types'
import type { Fetcher, FetcherOptions } from '@/scraper/interfaces'
```

**Причина:** `Fetcher` и `FetcherOptions` определены в `@/scraper/interfaces/index.ts`, а не в `@/scraper/types/index.ts`. Previous agent (`phase-1-robots-sitemap-full-stack-developer.md`) заметил это как pre-existing TS error. Исправлено — TypeScript теперь не ругается на missing exports.

## Files Created

| File | Lines | Purpose |
|---|---|---|
| `src/scraper/strategies/framework-detector.ts` | 215 | Определение веб-фреймворка + 5 характеристик сайта по HTML |
| `src/scraper/strategies/price-strategy-tester.ts` | 186 | Тестирование 5 стратегий извлечения цен на HTML |
| `src/scraper/strategies/__test__/framework-test.ts` | 158 | Test script на 3 синтетических HTML (Bitrix, Next.js, Angular SSR) |
| `src/scraper/strategies/static-fetcher.ts` | 175 | Bugfix импорта (без увеличения строк) |

Все файлы ≤ 250 строк ✅.

## API Surface

### `detectFramework(html: string): FrameworkDetectionResult`

```typescript
interface FrameworkDetectionResult {
  framework: Framework  // 'bitrix' | 'next' | 'nuxt' | 'angular' | 'vue' | 'react-spa' | 'tilda' | 'wordpress' | 'custom' | 'unknown'
  confidence: number    // 0-100, max weight of matched signal
  signals: string[]     // сработавшие признаки, например ["next: __NEXT_DATA__ script"]
  isSSR: boolean
  hasEmbeddedState: boolean  // __NEXT_DATA__ | G.json./api/ | window.__INITIAL_STATE__ | __APOLLO_STATE__ | __NUXT__
  hasSchemaOrg: boolean      // itemprop= или <script type="application/ld+json">
  currencyFormat: '₽' | 'руб.' | 'р.' | 'rub' | 'mixed'
  antiBotHints: AntiBotHints // { cloudflare?, recaptcha?, datadome?, perimeterX?, akamai?, jsChallenge?, rateLimitHeaders? }
}
```

Синхронная чистая функция — НЕ бросает exceptions.

### `testPriceStrategies(options): Promise<PriceStrategyTest[]>`

```typescript
interface PriceStrategyTesterOptions {
  sampleUrls: string[]    // URL'ы для отчёта (длина = sampleHtmls.length)
  sampleHtmls: string[]   // уже загруженные HTML
}

interface PriceStrategyTest {
  strategy: PriceStrategyName  // schema_org | data_attributes | embedded_json | css_class | seo_text_block
  attempted: boolean
  success: boolean             // true если itemsExtracted >= 3
  itemsExtracted: number       // суммарно по всем sampleHtmls
  sampleUrls: string[]         // URL'ы, на которых стратегия нашла матчи
  confidence: number           // min(100, itemsExtracted * 10)
  error?: string
}
```

Async функция (cheerio может быть асинхронным в будущем). НЕ бросает exceptions — отдельная стратегия может упасть, остальные продолжают.

## Verification

- `bun run lint` — 0 ошибок, 0 предупреждений ✅
- `bun x tsc --noEmit` — 0 ошибок в src/scraper/ и src/lib/ ✅
  (pre-existing ошибки только в `examples/` и `skills/` — не наши)
- Bugfix подтверждён: `src/scraper/strategies/static-fetcher.ts` теперь корректно импортирует
  `Fetcher`/`FetcherOptions` из `@/scraper/interfaces`. TypeScript больше не ругается на missing exports.

## Design Decisions

1. **weight-based выбор фреймворка**: если несколько сигналов сработали (например next + react-spa),
   выбираем тот, что с большим weight (next=95 > react-spa=65). Это правильно: Next.js построен
   на React, и data-reactroot может встретиться в Next-приложениях, но `__NEXT_DATA__` — более
   специфичный сигнал.

2. **hasRealContent**: body text > 500 chars ИЛИ > 100 chars БЕЗ пустого root div. Это эвристика —
   реальные SPA имеют `<div id="root"></div>` (пустой). Если body содержит > 500 chars — это SSR
   даже без явных фреймворк-маркеров (например custom Go/PHP рендеринг).

3. **currencyFormat "mixed"**: если разница между top и second форматом ≤ `max(2, top*0.2)` — mixed.
   Защищает от ложного выбора, когда сайт использует несколько форматов в равных пропорциях.

4. **embedded_json для Next.js**: `__NEXT_DATA__` присутствие = 1 blob (внутри может быть N цен,
   но без JSON-path экстрактора мы не можем их посчитать на этапе probe — это работа парсера
   в Phase 4). Для Helix: `G.json./api/` ключи считаем напрямую — каждый ключ = один ответ API.

5. **seo_text_block**: двухуровневый regex — сначала блок (жадный до `</p>`), потом внутри item pattern.
   Это позволяет находить `"Услуги: ... Консультация - 1500 руб. ... УЗИ - 2000 руб. ... </p>"`.

6. **countRegexMatches**: защита от zero-length match + reset lastIndex (regex переиспользуемые
   между вызовами). Если этого не сделать — повторный вызов функции с тем же regex сломается
   (lastIndex не 0).

7. **testPriceStrategies НЕ падает** при исключении в одной стратегии — `catch + warn + count=0`.
   Это важно: cheerio может упасть на очень сломанном HTML, но остальные 4 стратегии должны
   продолжить работу.

8. **antiBotHints.jsChallenge**: true если cloudflare/datadome/perimeterX/akamai true. Это
   позволяет Probe Engine'у быстро понять, что нужен stealth fetcher без перебора всех hints.

## Test Fixtures (framework-test.ts)

3 синтетических HTML-фикстуры, имитирующих разные фреймворки:

### 1. Bitrix (T1)
- `class="bx-core bx-mac"` (body)
- `/bitrix/templates/main/style.css` + `/bitrix/js/main/core/core.js` (asset paths)
- 5× `<span itemprop="price">` (₽, р., руб. mixed)
- `<meta itemprop="priceCurrency" content="RUB">`

### 2. Next.js (T2)
- `<div id="__next">` (root container)
- 4× `data-eec-price="..."` (Gemotest-style)
- `<script id="__NEXT_DATA__" type="application/json">...</script>`

### 3. Angular SSR (T2)
- `<app-root ng-version="17.0.0" _nghost-serverapp-c1261994999="">`
- `_ngcontent-serverapp-c1261994999=""` attrs на вложенных элементах
- `<script>window.__INITIAL_STATE__ = ...</script>`

## Hand-off to Next Agent

Следующие шаги (Phase 1 — Probe Engine):
1. Реализовать ProbeEngine orchestrator, который:
   - Fetch homepage через `getStaticFetcher()`
   - Вызывает `detectFramework(html)` → заполняет `ProbeResult.framework`, `isSSR`,
     `hasEmbeddedState`, `hasSchemaOrg`, `currencyFormat`, `antiBotHints`
   - Fetch robots.txt через `fetchAndParseRobots()` → `ProbeResult.robotsTxt`
   - Fetch sitemap через `fetchSitemap()` → `ProbeResult.sitemapUrls`, `totalUrlsDiscovered`
   - Берёт 3-5 sample URLs из sitemap (приоритет — `/catalog/`, `/services/`, `/prices/`)
   - Fetch HTML этих URL'ов
   - Вызывает `testPriceStrategies({ sampleUrls, sampleHtmls })` → `ProbeResult.priceStrategies`
2. Реализовать detectRegionStrategy (раздел 2.5)
3. Реализовать classifyTier (раздел 2.4 — Tier classification matrix)
4. Реализовать computeConfidence (агрегация confidence из framework + priceStrategies + sitemapCoverage)
5. Реализовать generateSpec (YAML из ProbeResult)

## Hand-off Notes

- `FrameworkDetectionResult` interface from `framework-detector.ts` — НЕ то же самое что поля в
  `ProbeResult` (types/index.ts). ProbeEngine должен сопоставить поля вручную:
  - `result.framework` → `ProbeResult.framework`
  - `result.isSSR` → `ProbeResult.isSSR`
  - `result.hasEmbeddedState` → `ProbeResult.hasEmbeddedState`
  - `result.hasSchemaOrg` → `ProbeResult.hasSchemaOrg`
  - `result.currencyFormat` → `ProbeResult.currencyFormat`
  - `result.antiBotHints` → `ProbeResult.antiBotHints`
  - `result.confidence` и `result.signals` — для логирования/аудита (не в ProbeResult напрямую,
    но могут попасть в `tierReasoning`)

- `testPriceStrategies` возвращает `PriceStrategyTest[]` — это в точности поле `ProbeResult.priceStrategies`.

- Все 3 функции ЧИСТЫЕ (кроме логирования) — можно вызывать параллельно для нескольких сайтов.
