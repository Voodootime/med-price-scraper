# Task: phase-1-robots-sitemap

**Agent:** full-stack-developer
**Date:** 2025
**Scope:** robots.txt parser + sitemap fetcher for Probe Engine (Phase 1)

## Context Reference

Перед началом работы прочитал:
- `/home/z/my-project/worklog.md` — все предыдущие фазы (Phase 0: foundation, dashboard, verification, download endpoints)
- `/home/z/my-project/docs/scraping-methodology.md` — раздел 2 (Probe Engine), раздел 3 (Discovery Engine), раздел 3.2 (Sitemap discovery приоритет #1)
- `/home/z/my-project/src/scraper/types/index.ts` — ProbeResult.robotsTxt shape
- `/home/z/my-project/src/scraper/interfaces/index.ts` — DiscoveryStrategy, DiscoveryOptions
- `/home/z/my-project/src/scraper/strategies/static-fetcher.ts` — готовый StaticFetcher (singleton через getStaticFetcher())
- `/home/z/my-project/src/scraper/utils/price.ts` — sha256 и др. утилиты
- `/home/z/my-project/src/lib/logger/index.ts` — pino logger + child-логгеры

## Files Created

| File | Lines | Purpose |
|---|---|---|
| `src/scraper/strategies/robots-fetcher.ts` | 180 | Парсер robots.txt (sitemap URLs, disallow, allow, crawlDelay) |
| `src/scraper/strategies/sitemap-fetcher.ts` | 199 | Рекурсивный парсер sitemap.xml (sitemapindex + urlset + gzip) |
| `src/scraper/strategies/__test__/robots-sitemap-test.ts` | 102 | Test script для cmd-online.ru (НЕ запускается автоматически) |

## API Surface

### `fetchAndParseRobots(baseUrl: string): Promise<ParsedRobots | null>`

```typescript
interface ParsedRobots {
  sitemaps: string[]        // из поля Sitemap:
  disallow: string[]        // для User-agent: *
  allow: string[]           // для User-agent: *
  crawlDelay?: number       // в секундах
  raw: string               // сырой текст (для audit/debug)
}
```

Поведение:
- 404 / 4xx / 5xx / network error → `null` (сигнал "можно всё" или сайт недоступен)
- 200 → `ParsedRobots`

### `fetchSitemap(sitemapUrl, options?): Promise<SitemapUrl[]>`

```typescript
interface SitemapUrl {
  url: string
  lastmod?: string
  changefreq?: string
  priority?: number
}

interface FetchSitemapOptions {
  maxUrls?: number        // default 100000 — защита от OOM
  timeoutMs?: number      // default 30000
  onProgress?: (count: number, currentUrl: string) => void
}
```

Поведение:
- `<sitemapindex>` → рекурсивный спуск (CONCURRENCY=5, MAX_DEPTH=5)
- `<urlset>` → извлечение всех `<url>`
- `.xml.gz` → автоматическая распаковка (node:zlib gunzipSync)
- Ошибка / timeout / invalid XML → пустой массив (НЕ бросает)
- linkedom DOMParser как основной XML-парсер + regex fallback

## Verification

- `bun run lint` — 0 ошибок, 0 предупреждений ✅
- `bun x tsc --noEmit` — 0 ошибок в новых файлах (есть pre-existing в static-fetcher.ts, не моя задача)
- Smoke test (для self-verification):
  - `fetchAndParseRobots('https://www.cmd-online.ru')` → 3 sitemap, 116 disallow, 12 allow, crawlDelay=3 ✅
  - `fetchSitemap('https://www.cmd-online.ru/sitemap.xml', {maxUrls:100})` →
    sitemapindex detected, рекурсивно зашёл в sub-sitemap (sitemap-iblock-6.xml, sitemap-iblock-11.xml),
    извлёк 100 URL с lastmod, maxUrls limit сработал корректно ✅

## Design Decisions

1. **robots-parser не экспортирует raw rules** → написал свой мини-парсер для User-agent: *
   (поддерживает оба формата: один UA на блок и несколько UA на общий блок).
2. **linkedom может упасть на битом XML** → добавлен regex-fallback (для sitemap структуры это надёжно).
3. **gzip sitemap нельзя fetch через StaticFetcher** (он декодирует как UTF-8, портит binary) →
   для `.gz` использую raw `fetch()` + `gunzipSync` из `node:zlib`.
4. **StaticFetcher имеет rateLimitMs=2000 по умолчанию** → замедлил бы рекурсивный обход sitemap.
   Передаю `rateLimitMs=0` (politeness оставляем на уровне планировщика scrape-run'а).
5. **maxUrls default 100000** — защита от OOM на гигантских sitemap (некоторые сайты имеют 50k+ URL).
6. **MAX_DEPTH=5** — защита от циклических sitemap-ссылок.
7. **visited Set** — защита от повторной обработки одного и того же sitemap URL.

## Hand-off to Next Agent

Следующие шаги (Phase 1 — Probe Engine):
1. Реализовать полный ProbeEngine, который использует:
   - `fetchAndParseRobots()` → `ProbeResult.robotsTxt`
   - `fetchSitemap()` → `ProbeResult.sitemapUrls`, `totalUrlsDiscovered`
2. Реализовать Discovery Engine (раздел 3 методологии):
   - SitemapDiscoveryStrategy (приоритет #1) — обёртка над fetchSitemap
   - LinkAnalysisStrategy (приоритет #2)
   - BFSCrawlStrategy (приоритет #3)
   - WebSearchStrategy (приоритет #4) — через z-ai-web-dev-sdk
   - CommonPathsStrategy (приоритет #5)
3. Реализовать ProbeResult.regionStrategy detection (раздел 2.5)
4. Реализовать ProbeResult.tier classification (раздел 2.4)
5. Реализовать spec.yaml generator из ProbeResult

Pre-existing issue (НЕ блокер, не моя задача):
- `src/scraper/strategies/static-fetcher.ts` line 17: импортирует `Fetcher`, `FetcherOptions` из `@/scraper/types`, но они находятся в `@/scraper/interfaces`. Это pre-existing TS error, не влияет на runtime (type-only import).
