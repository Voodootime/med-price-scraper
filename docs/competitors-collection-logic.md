# Логика работы со всеми конкурентами

> Полное техническое описание того, как система собирает данные с каждого
> медицинского сайта. Документ является "инструкцией по эксплуатации" для
> разработчиков и операторов. Для каждого конкурента описаны: архитектура
> сайта, метод сбора, URL discovery, parser strategy, region handling,
> специфические особенности, требования к fixtures и validation rules.
>
> **Связанные документы:**
> - `docs/scraping-methodology.md` — полная методология (1847 строк)
> - `docs/development-roadmap-detailed.md` — roadmap с milestones M1-M7
> - `docs/testing-guide.md` — сценарий тестирования

---

## 1. Общая архитектура pipeline

### 1.1. End-to-end поток данных

```
Пользователь добавляет URL
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. PROBE ENGINE                                             │
│    Вход: URL главной страницы                               │
│    Выход: ProbeResult { tier, framework, regionStrategy,   │
│            priceStrategies[], confidenceScore, sitemapUrls }│
│                                                             │
│    Шаги:                                                    │
│    a) fetch robots.txt → sitemap URLs, Disallow rules      │
│    b) fetch homepage → framework, SSR/SPA, Schema.org,     │
│       currency, antiBot hints                              │
│    c) fetch sitemap → все URL (с лимитом 10k для probe)    │
│    d) sample 3-5 URL → test 5 price strategies             │
│    e) detect region_strategy (8 типов)                     │
│    f) classify tier (T1-T10)                               │
│    g) compute confidence (0-100)                           │
│    h) generate spec.yaml                                   │
│                                                             │
│    Результат сохраняется в БД:                             │
│    - ProbeResult (полный отчёт в JSON)                     │
│    - ScrapeSpec (auto-generated, confidence-based status)  │
│    - Competitor обновляется (tier, regionStrategy, status) │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. DISCOVERY ENGINE                                         │
│    Вход: baseUrl, region, regionStrategy, ProbeResult      │
│    Выход: DiscoveredUrl[] (отфильтрованные по region)      │
│                                                             │
│    Шаги:                                                    │
│    a) fetch sitemap(s) из ProbeResult.robotsTxt.sitemaps   │
│    b) рекурсивно парсить sitemapindex → sub-sitemaps       │
│    c) для каждого URL:                                     │
│       - normalizeDiscoveryUrl()                            │
│       - isSameSite() — только same domain                  │
│       - matchesTargetRegion() — фильтр по scope            │
│       - categorizeUrl() — catalog/service/clinic/doctor    │
│       - isLikelyPriceUrl() — отбросить статьи/врачей       │
│       - scoreLikelyPriceUrl() — ранжирование               │
│    d) сортировка по score, slice(maxUrls)                  │
│                                                             │
│    Результат: prioritized URL list для scrape              │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. SCRAPE RUNNER (health-aware candidate loop)              │
│    Вход: competitorId, region, maxUrls, specId             │
│    Выход: ScrapeRun { status, itemsExtracted, services,    │
│            snapshots, errors }                              │
│                                                             │
│    Для каждого URL из discovery:                           │
│    a) FETCH: StaticFetcher (T1/T2) или Playwright (T3+)    │
│       - retry с exponential backoff (1s→2s→4s→8s)         │
│       - rate limit (2s default, per-domain)                │
│       - User-Agent ротация (5 браузерных UA)               │
│       - trailing slash fallback (404 → добавить /)         │
│    b) HEALTH CHECK:                                         │
│       - HTTP 404/403/5xx → записать в candidateErrors,    │
│         перейти к следующему URL                           │
│       - пустой HTML (< 1KB) → следующий URL                │
│       - parser вернул 0 items → следующий URL              │
│    c) PARSE: HtmlPriceParser (4 стратегии)                 │
│       - schema_org (приоритет 1, confidence 95)            │
│       - data_attributes (приоритет 2, confidence 90)       │
│       - embedded_json (приоритет 3, confidence 85)         │
│       - css_class (приоритет 4, confidence 65)             │
│       - dedupeCandidates() — по externalId                 │
│    d) VALIDATE: DefaultValidator                           │
│       - обязательные поля (externalId, name, price, url)   │
│       - price range [10 RUB, 100,000 RUB]                  │
│       - price must be integer (kopecks)                    │
│       - URL must be http/https                             │
│       - duplicate externalId detection                     │
│    e) PERSIST: если validation.ok                           │
│       - upsert Service (по competitorId + externalId)      │
│       - create PriceSnapshot (с deltaPct если цена сменилась)│
│       - update Competitor (lastScrapeAt, itemsCount)       │
│    f) UPDATE ScrapeRun:                                    │
│       - urlsFetched, urlsSucceeded, urlsFailed             │
│       - itemsExtracted, itemsAdded, itemsChanged           │
│       - nullFieldsRate, structureDiff                      │
│                                                             │
│    Финал:                                                   │
│    - computeRunStatus(): success / partial / failed        │
│    - update Competitor.status (active / needs_review)      │
│    - create ScrapeAlert если есть проблемы                 │
└─────────────────────────────────────────────────────────────┘
```

### 1.2. Стратегии fetcher (по тиру)

| Тир | Fetcher | Особенности |
|---|---|---|
| **T1, T1_schema_org** | StaticFetcher (undici fetch) | curl-эквивалент, без JS, ~85 КБ/стр |
| **T2** | StaticFetcher | То же, но parser ищет embedded JSON |
| **T3** | PageReaderFetcher (z-ai SDK) | Выполняет JS, рендерит SPA |
| **T4-T5** | PlaywrightFetcher | Полный браузер, scroll для lazy-load |
| **T6-T7** | StealthFetcher | playwright-extra + stealth + proxy |
| **T8** | VLMFetcher | screenshot → VLM → JSON |

**Текущая реализация:** только StaticFetcher (T1/T2). Playwright/PageReader/VLM — planned.

### 1.3. Стратегии parser (по приоритету)

Parser пробует стратегии **по очереди**, пока не получит ≥1 валидных item:

```
┌─────────────────────────────────────────────────────────┐
│ 1. schema_org (confidence 95)                           │
│    Regex: <span[^>]*itemprop="price"[^>]*>([^<]+)</span>│
│    + itemprop="name", itemprop="priceCurrency"          │
│    Работает на: CMD, любой сайт с Schema.org            │
├─────────────────────────────────────────────────────────┤
│ 2. data_attributes (confidence 90)                      │
│    Regex: data-(?:eec-)?price="([^"]+)"                 │
│    + data-eec-name, data-eec-id, data-eec-sec           │
│    Работает на: Gemotest                                 │
├─────────────────────────────────────────────────────────┤
│ 3. embedded_json (confidence 85)                        │
│    Regex: "G.json./api/..." или __NEXT_DATA__            │
│    JSON-path extraction                                  │
│    Работает на: Helix                                    │
├─────────────────────────────────────────────────────────┤
│ 4. css_class (confidence 65)                            │
│    Cheerio: $('[class*="price"]')                       │
│    + findNameNear() для name                            │
│    Работает на: Veramed, Altamed+, Medsi (fallback)     │
├─────────────────────────────────────────────────────────┤
│ 5. seo_text_block (confidence 50) — PLANNED             │
│    Regex: <p class="hdn">Прием специалиста:...руб.</p>  │
│    Работает на: Medsi services (min-цены)               │
└─────────────────────────────────────────────────────────┘
```

### 1.4. Filter pipeline (после parser, до persist)

```
items из parser
    │
    ▼
┌─────────────────────────────────────────────────┐
│ FILTER 1: dedupeByExternalId()                  │
│   Ключ: (region, locationKey, externalId)       │
│   Оставить: первый (наивысший confidence)       │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ FILTER 2: buildItem() false positive filters    │
│   - price < 10 RUB → reject (единицы измерения) │
│   - price > 100,000 RUB → reject (codes)        │
│   - priceRaw == code → reject                   │
│   - css_class + digits-only ≥ 5 → reject        │
│   - name like "мг/дл" → reject                  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ FILTER 3: DefaultValidator.validateBatch()      │
│   - обязательные поля не пустые                 │
│   - price в диапазоне [10, 100000] RUB          │
│   - URL валидный (http/https)                   │
│   - parseConfidence 0-100                       │
│   - minItems check (≥1)                         │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
              persistItems()
```

---

## 2. Конкурент 1: CMD Online (cmd-online.ru)

### 2.1. Архитектура сайта

| Характеристика | Значение |
|---|---|
| **CMS** | 1С-Битрикс |
| **Tier** | T1 + Schema.org (эталон) |
| **Framework detection** | `class="bx-core"`, `/bitrix/` в asset paths |
| **SSR** | Да (серверный HTML) |
| **Schema.org** | Да (`itemprop="price"`, `itemprop="priceCurrency"`) |
| **Currency** | ₽ (символ) + "р." (сокращение) |
| **Anti-bot** | Нет |
| **Sitemap** | `https://www.cmd-online.ru/sitemap.xml` (index из 17 sub-sitemaps) |
| **robots.txt** | Дружелюбный, sitemap указан явно |

### 2.2. URL structure

```
/analizy-i-tseny/katalog-analizov/{city}/{slug}_{code}/
                                         │       │
                                         │       └── код анализа (100002, 090037, ...)
                                         └── slug города (msk, odintsovo, spb, ...)

Примеры:
  /analizy-i-tseny/katalog-analizov/msk/gluten/
  /analizy-i-tseny/katalog-analizov/msk/protrombin_..._100002/
```

### 2.3. Region strategy: `url_path_segment`

```yaml
region_strategy:
  type: url_path_segment
  param: city_slug
  mapping:
    moscow: msk
    mo: msk           # цены одинаковы по всем городам (проверено)
  scope_optimization: |
    Цены одинаковы по всем 86 городам CMD.
    Собираем только /msk/ URL'ы — покрывает всю РФ.
```

**Логика фильтрации (matchesTargetRegion):**
1. URL содержит `/msk/` → pass ✅
2. URL содержит `/podolsk/`, `/aleksin/`, `/balashikha/` (любой известный город ≠ msk) → reject ❌
3. URL не содержит city segment → pass (может быть generic страница)

### 2.4. Discovery

```
Вход: https://www.cmd-online.ru/sitemap.xml
      → 17 sub-sitemaps (sitemap-iblock-11.part1..6.xml = основной каталог)
      → 132 866 total URL (1 510 анализов × 86 городов)

После фильтрации (region=mo, target=msk):
  → ~1 510 URL (только /msk/ сегмент)

После scoreLikelyPriceUrl():
  → URL с числовым кодом в конце получают +30 к score
  → URL с 'analizy-i-tseny/katalog-analizov' получают +35
  → Сортировка по score, slice(maxUrls)
```

### 2.5. Parser strategy: schema_org (primary)

**HTML структура карточки анализа:**
```html
<div itemprop="offer">
  <meta itemprop="priceCurrency" content="RUB">
  <link itemprop="availability" href="http://schema.org/InStock">
  <span itemprop="price">810</span> р.
</div>
<h1 itemprop="name">Глютен (клейковина), IgE в Москве</h1>
```

**Extraction logic:**
1. Найти `[itemprop="price"]` → priceRaw = "810"
2. Найти ближайший container с `itemprop="offer"` или `itemscope`
3. В container найти `[itemprop="name"]` → nameRaw
   - **Приоритет:** container name → H1 → body name (skip head) → title
   - **Важно:** не брать `[itemprop="name"]` из `<head>` (там "CMD" — название сайта)
4. В container найти `[itemprop="priceCurrency"]` → currency
5. В container найти `[itemprop="availability"]` → available

**ExternalId:**
- Если URL содержит `_{code}/` (например `_100002/`) → externalId = code, externalIdType = "code"
- Иначе → externalId = slug из URL, externalIdType = "slug"

### 2.6. Специфические особенности

| Особенность | Решение |
|---|---|
| **86 городов в URL** | Собираем только `/msk/` (цены одинаковы) |
| **Sitemap 132k URL** | Discovery фильтрует по region, остаётся ~1.5k |
| **"CMD" в `<head>` как itemprop="name"** | Parser ищет name в container → H1 → body (skip head) |
| **data-code атрибуты** | Не путать с ценой (filter: priceRaw ≠ code) |
| **30 топ-анализов на главной каталога** | Discovery их не берёт (BROAD_PRICE_PATHS penalty) |
| **Устаревшие COVID-страницы** | BLOCKED_PRICE_PATH_HINTS: 'covid', 'urgent-analyzes' |

### 2.7. Validation rules (CMD-specific)

```yaml
validation:
  min_items: 500           # из 1 510 URL ожидаем ≥500 с ценой
  max_items: 2000
  price_range: [10, 100000] # RUB
  pages_with_price_ratio: 0.95  # 95% карточек имеют Schema.org
  alert_if_items_drop_pct: 50   # если items упали >50% → alert
```

### 2.8. Fixture requirements

```
src/scraper/parsers/__test__/fixtures/
  ├── cmd-gluten.html          ✅ существует (90 КБ, карточка /msk/gluten/)
  ├── cmd-protrombin.html      ⬜ TODO (карточка с code в URL)
  ├── cmd-index-top30.html     ⬜ TODO (главная каталога, 30 топ-анализов)
  └── cmd-404.html             ⬜ TODO (404 страница для health-check)
```

### 2.9. Текущий статус

- ✅ Probe Engine: определяет bitrix, T1, url_path_segment, confidence=85
- ✅ Discovery: фильтрует только /msk/ URL
- ✅ Parser: schema_org, 1 clean item (Иммуноглобулин Е, 790 RUB)
- ✅ ScrapeRun: status=success
- ✅ Fixture: cmd-gluten.html
- ✅ Parser test: 9/9 assertions
- ⬜ TODO: добавить ещё 3 fixtures для edge cases

---

## 3. Конкурент 2: Gemotest (gemotest.ru)

### 3.1. Архитектура сайта

| Характеристика | Значение |
|---|---|
| **CMS** | 1С-Битрикс |
| **Tier** | T1 (static HTML) |
| **Framework detection** | `class="bx-core"`, `/bitrix/` |
| **SSR** | Да |
| **Schema.org** | Нет (использует data-eec-* атрибуты) |
| **Currency** | ₽ |
| **Anti-bot** | Нет |
| **Sitemap** | Не найден (discovery через BFS от /catalog/) |
| **robots.txt** | `Disallow: /*?` (все query-параметры запрещены) |

### 3.2. URL structure

```
/{city}/catalog/                           ← главная каталога (10 топ-анализов)
/{city}/catalog/{section}/{subsection}/    ← категория (анализы внутри)
/{city}/catalog/{section}/{subsection}/{slug}/  ← карточка анализа

Примеры:
  /moskva/catalog/                                    ← каталог Москвы
  /moskva/catalog/issledovaniya-krovi/klinicheskie-issledovaniya/
  /moskva/catalog/issledovaniya-krovi/biokhimiya/
```

### 3.3. Region strategy: `url_prefix`

```yaml
region_strategy:
  type: url_prefix
  param: city_slug
  mapping:
    moscow: moskva
    mo: moskva         # Москва и МО используют один slug
    spb: sankt-peterburg
```

**Логика фильтрации:**
1. URL начинается с `/moskva/` → pass ✅
2. URL начинается с `/sankt-peterburg/` → reject (другой регион) ❌
3. URL не содержит city prefix → reject (не каталог) ❌

### 3.4. Discovery

```
Вход: https://gemotest.ru/moskva/catalog/  (главная каталога для Москвы)

Discovery strategy: BFS crawl (sitemap не найден)
  1. GET /moskva/catalog/ → extract .category-item__link URLs
  2. Для каждой категории: GET → extract analysis-item URLs
  3. Для каждой подкатегории: GET → extract analysis-item URLs

Результат: ~66 URL категорий + ~3 300 URL карточек анализов
```

### 3.5. Parser strategy: data_attributes (primary)

**HTML структура карточки анализа:**
```html
<div class="analysis-item with--cart-widget"
     data-eec-catalogid="cat-1134"
     data-eec-name="Общий анализ мочи"
     data-eec-id="9.1."
     data-eec-link="klinicheskie-issledovaniya"
     data-eec-price="400"
     data-eec-sec="Клинические исследования">
  <a href="/moskva/catalog/.../obshchiy-analiz-mochi/" class="analysis-item__title">
    Общий анализ мочи
  </a>
  <div class="analysis-item__info">
    <span class="analysis-item__info_taking">Моча</span>
    <span class="analysis-item__info_bonuses">40</span>
    <span class="analysis-item__info_time">1 день</span>
  </div>
</div>
```

**Extraction logic:**
1. Найти все элементы с `data-eec-catalogid` (это карточки анализа)
2. Извлечь атрибуты:
   - `data-eec-catalogid` → externalId (cat-1134)
   - `data-eec-name` → nameRaw
   - `data-eec-id` → code (9.1.)
   - `data-eec-price` → priceRaw (400, в рублях)
   - `data-eec-sec` → category
   - `data-eec-link` → slug
3. Найти `analysis-item__info` → biomaterial, bonuses, estimatedDays

**Важно:** на странице категории все анализы уже в HTML (не AJAX). Один fetch = десятки items.

### 3.6. Специфические особенности

| Особенность | Решение |
|---|---|
| **Нет sitemap** | BFS discovery от /moskva/catalog/ |
| **Slug с "ё"** | `onkomarkyery` (не `onkomarkery`) — URL брать из HTML, не транслитерировать |
| **66 категорий** | Discovery парсит .category-item__link |
| **data-eec-* атрибуты** | Parser: data_attributes стратегия |
| **Цены на странице категории** | Один fetch = много items (эффективно) |
| **Бонусы (10% от цены)** | Извлечь из analysis-item__info_bonuses |
| **Срок исполнения** | Извлечь из analysis-item__info_time |

### 3.7. Validation rules (Gemotest-specific)

```yaml
validation:
  min_items: 2000          # ожидаем ~3 300 анализов
  max_items: 5000
  price_range: [50, 50000] # RUB
  pages_with_price_ratio: 0.90
  alert_if_items_drop_pct: 30
```

### 3.8. Fixture requirements

```
src/scraper/parsers/__test__/fixtures/
  ├── gemotest-clinical-category.html  ⬜ TODO (страница категории с 15 анализами)
  ├── gemotest-biochemistry-category.html ⬜ TODO (страница с 290 анализами)
  ├── gemotest-analysis-card.html      ⬜ TODO (индивидуальная карточка)
  └── gemotest-catalog-index.html      ⬜ TODO (главная /moskva/catalog/)
```

### 3.9. Текущий статус

- ⬜ Probe Engine: не запускался на Gemotest
- ⬜ Discovery: не реализован BFS для сайтов без sitemap
- ⬜ Parser: data_attributes стратегия есть в коде, но не тестировалась на Gemotest
- ⬜ Fixture: нет
- ⬜ Parser test: нет

**Что нужно сделать:**
1. Fetch `/moskva/catalog/issledovaniya-krovi/klinicheskie-issledovaniya/` → сохранить fixture
2. Написать parser test (проверить data-eec-* извлечение)
3. Реализовать BFS discovery (или использовать sitemap если найдётся)
4. Прогнать scrape-run с maxUrls=3

---

## 4. Конкурент 3: Helix (helix.ru)

### 4.1. Архитектура сайта

| Характеристика | Значение |
|---|---|
| **Framework** | Angular 16 (SSR) |
| **Tier** | T2 (SSR + embedded JSON) |
| **Framework detection** | `ng-version="16.2.12"`, `_nghost-serverapp-`, `ng-server-context="ssr"` |
| **SSR** | Да (Angular Universal) |
| **Schema.org** | Нет |
| **Currency** | ₽ |
| **Anti-bot** | Нет |
| **Sitemap** | Не найден |
| **robots.txt** | Стандартный |

### 4.2. URL structure

```
/catalog/190-vse-analizy?page=N     ← все анализы (90 страниц по 12)
/catalog/{id}-{slug}                ← категория
/catalog/item/{code}                ← карточка анализа

Примеры:
  /catalog/190-vse-analizy?page=1
  /catalog/1-populyarnye-analizy
  /catalog/item/02-005
```

### 4.3. Region strategy: `ip_default`

```yaml
region_strategy:
  type: ip_default
  note: |
    Angular SSR определяет город по IP клиента.
    Cookie cityId=1 не работает — сервер игнорирует.
    Для смены региона нужен proxy с IP целевого города.
    Из sandbox: видим СПб (cityId=2).
    Для Москвы: нужен residential proxy с MSK IP.
```

**Логика фильтрации:**
- `ip_default` → `matchesTargetRegion()` возвращает true для всех URL (регион определяется сервером)
- Все URL проходят discovery, но цены будут для одного города

### 4.4. Discovery

```
Вход: https://helix.ru/catalog/190-vse-analizy

Discovery strategy: pagination crawl
  1. GET /catalog/190-vse-analizy → extract pagination (page 1..90)
  2. Для каждой страницы: GET ?page=N → extract embedded JSON
  3. Каждая страница содержит 12 анализов в JSON-блобе

Результат: 90 страниц × 12 = ~1 078 анализов
```

### 4.5. Parser strategy: embedded_json (primary)

**HTML структура (Angular SSR):**
```html
<script>
  window.__NG_DATA__ = {
    "G.json./api/catalog/items/list/v2?cityId=2&filter.categoryId=190&pagination.take=12&pagination.skip=0?": {
      "body": {
        "total": 1078,
        "catalogItems": [
          {
            "id": 1400,
            "hxid": "02-011",
            "title": "Проба Реберга (клиренс эндогенного креатинина)",
            "price": 675,
            "marketPrice": null,
            "currency": { "code": "643", "name": "руб.", "symbol": "₽" },
            "estimateInfo": "До 12 часов. Указанный срок не включает день взятия биоматериала",
            "isComplex": true,
            "canPreOrder": true,
            "preorderAvailability": "Available"
          }
        ]
      }
    }
  };
</script>
```

**Extraction logic:**
1. Найти `"G.json./api/catalog/items/list/v2..."` в HTML
2. Извлечь JSON-блоб после `{"body":`
3. Парсить JSON → `catalogItems[]` массив
4. Для каждого item:
   - `hxid` → externalId (02-011), externalIdType = "hxid"
   - `title` → nameRaw
   - `price` → price (в рублях, ×100 для копеек)
   - `marketPrice` → marketPrice (если есть, для скидок)
   - `estimateInfo` → estimatedDays
   - `isComplex` → (boolean, для информации)

### 4.6. Специфические особенности

| Особенность | Решение |
|---|---|
| **Angular SSR** | JSON встроен в HTML (не нужен Playwright) |
| **Embedded JSON** | Regex: `"G\.json\./api/catalog/items/list/v2[^"]+"\s*:\s*\{"body":(\{)` |
| **Pagination** | `?page=N` (N=1..90) |
| **page_reader режет query** | Использовать прямой `fetch` (undici), не z-ai page_reader |
| **IP-geolocation** | Нужен proxy для смены города |
| **1 078 анализов** | 90 страниц × 12 items = полный каталог |
| **hxid как stable ID** | Человеко-читаемый (02-005), стабилен между запусками |
| **marketPrice для скидок** | Сохранять в PriceSnapshot.marketPrice |

### 4.7. Validation rules (Helix-specific)

```yaml
validation:
  min_items: 900           # ожидаем ~1 078
  max_items: 1500
  price_range: [50, 50000] # RUB
  pages_with_price_ratio: 1.0  # каждая страница имеет JSON
  alert_if_items_drop_pct: 20
```

### 4.8. Fixture requirements

```
src/scraper/parsers/__test__/fixtures/
  ├── helix-page1.html     ⬜ TODO (страница 1, embedded JSON с 12 items)
  ├── helix-page90.html    ⬜ TODO (последняя страница, 10 items)
  └── helix-item-card.html ⬜ TODO (индивидуальная карточка /catalog/item/02-005)
```

### 4.9. Текущий статус

- ⬜ Probe Engine: определяет Angular, T2, embedded_json (проверено в разведке)
- ⬜ Discovery: не реализован pagination crawl
- ⬜ Parser: embedded_json стратегия есть в коде, но regex не протестирован на реальном Helix HTML
- ⬜ Proxy: нужен для MSK IP
- ⬜ Fixture: нет

**Что нужно сделать:**
1. Fetch `/catalog/190-vse-analizy?page=1` через прямой curl → сохранить fixture
2. Написать parser test (проверить JSON extraction из `"G.json./api/..."`)
3. Реализовать pagination discovery (?page=1..90)
4. Для production: настроить residential proxy с MSK IP

---

## 5. Конкурент 4: Veramed (veramed-clinic.ru)

### 5.1. Архитектура сайта

| Характеристика | Значение |
|---|---|
| **CMS** | 1С-Битрикс |
| **Tier** | T1 (static HTML) |
| **Framework detection** | `class="bx-core"`, `/bitrix/` |
| **SSR** | Да |
| **Schema.org** | Нет |
| **Currency** | ₽ |
| **Anti-bot** | Нет |
| **Sitemap** | Не нужен — весь прайс на одной странице |
| **robots.txt** | Стандартный |

### 5.2. URL structure

```
/price/    ← единственный URL, содержит весь прайс (3 261 услуга)

Структура внутри HTML:
  <div data-id="премиум">      ← тариф 1
    <div data-id="одинцово">   ← тариф 2
    <div data-id="звенигород"> ← тариф 3
```

### 5.3. Region strategy: `tariff_select`

```yaml
region_strategy:
  type: tariff_select
  param: tariff
  mapping:
    premium: премиум      ← премиум-тариф (Москва)
    odintsovo: одинцово   ← Одинцово (МО)
    zvenigorod: звенигород ← Звенигород (МО)
  note: |
    Veramed — 3 клиники в МО.
    Все 3 тарифа на одной странице /price/.
    Собираем все 3 (тариф = locationKey).
```

**Логика:**
- URL не меняется (всегда `/price/`)
- Tariff определяется табом в HTML (`data-id="премиум"`)
- Каждый tariff = отдельный `locationKey` в PriceSnapshot

### 5.4. Discovery

```
Вход: https://veramed-clinic.ru/price/  (единственный URL)

Discovery: тривиальный — 1 URL
  → planned_urls = ['/price/']
```

### 5.5. Parser strategy: css_class (primary)

**HTML структура:**
```html
<div class="js-services-tab-content" data-id="премиум">
  <div class="js-servicesCategory-item servicesCategory__item">
    <div class="servicesCategory__title">
      <span>Аллергология</span>
    </div>
    <div class="services__list">
      <div class="js-service-item service__item">
        <div class="services__name">Прием (осмотр, консультация) врача-аллерголога-иммунолога первичный</div>
        <div class="service__item-right">
          <div class="services__price">3 150 ₽</div>
        </div>
      </div>
      <!-- ещё услуги... -->
    </div>
  </div>
</div>
```

**Extraction logic:**
1. Найти все `div[data-id]` (это табы тарифов) → tariff = data-id
2. В каждом табе найти `servicesCategory__title > span` → category
3. В каждой категории найти `js-service-item` → item
4. В item найти:
   - `services__name` → nameRaw
   - `services__price` → priceRaw ("3 150 ₽")
5. ExternalId = hash(normalize(name)) (нет stable ID)
6. locationKey = tariff (премиум/одинцово/звенигород)

### 5.6. Специфические особенности

| Особенность | Решение |
|---|---|
| **Весь прайс на 1 странице (3.4 МБ)** | Один fetch = 3 261 items (очень эффективно) |
| **3 тарифа в табах** | `data-id` атрибут = tariff = locationKey |
| **hidden атрибуты** | `hidden="hidden"` на услугах после 5-й в категории — НО все в HTML, парсим все |
| **Нет stable ID** | externalId = hash(normalize(name)) |
| **Категории внутри табов** | `servicesCategory__title` → category |
| **Цена "3 150 ₽"** | parsePrice() → 315000 копеек |

### 5.7. Validation rules (Veramed-specific)

```yaml
validation:
  min_items: 2500          # ожидаем ~3 261 (3 тарифа)
  max_items: 5000
  price_range: [100, 500000] # RUB (медуслуги дороже анализов)
  pages_with_price_ratio: 1.0  # 1 страница = 100%
  alert_if_items_drop_pct: 20
```

### 5.8. Fixture requirements

```
src/scraper/parsers/__test__/fixtures/
  └── veramed-price-full.html  ⬜ TODO (3.4 МБ, вся страница /price/)
```

**Важно:** fixture 3.4 МБ — большой, но необходимый. Добавить в .gitignore если превышает лимит, хранить в raw-lake.

### 5.9. Текущий статус

- ⬜ Не реализован (только разведка в методологии)
- ⬜ Fixture: нет
- ✅ Parser: css_class стратегия работает (протестирована на CMD)

**Что нужно сделать:**
1. Fetch `/price/` → сохранить fixture (3.4 МБ)
2. Адаптировать parser для multi-tariff extraction (data-id = tariff)
3. Написать parser test (проверить 3 тарифа + категории)
4. Прогнать scrape-run (1 URL = 3 261 items)

---

## 6. Конкурент 5: Altamed+ (altamedplus.ru)

### 6.1. Архитектура сайта

| Характеристика | Значение |
|---|---|
| **CMS** | 1С-Битрикс |
| **Tier** | T1 + discovery (distributed) |
| **Framework detection** | `class="bx-core"` |
| **SSR** | Да |
| **Schema.org** | Нет |
| **Currency** | "руб." (словом) + ₽ (стоматология) |
| **Anti-bot** | Нет |
| **Sitemap** | `https://www.altamedplus.ru/sitemap.xml` (неполный, 51 URL) |
| **robots.txt** | Дружелюбный |

### 6.2. URL structure

```
/services/                              ← топовые разделы
/services/vectors/{direction}/          ← 41 медицинское направление
/services/cure/{procedure}/             ← 243 индивидуальные процедуры
/services/analysis_and_diagnostics/...  ← 4 диагностических раздела
/services/stomatology/                  ← стоматология (другой формат таблицы)

Примеры:
  /services/vectors/kardiologiya/
  /services/cure/elektrokardiogramma-ekg/
  /services/stomatology/
```

### 6.3. Region strategy: `none`

```yaml
region_strategy:
  type: none
  note: |
    Altamed+ — сеть клиник только в МО (Дубки, Одинцово, Звенигород).
    Регион не влияет на URL или цены.
    Все страницы собираем без фильтрации.
```

### 6.4. Discovery

```
Вход: https://www.altamedplus.ru/services/

Discovery strategy: BFS crawl (sitemap неполный)
  1. GET /services/ → extract /services/vectors/, /services/cure/, etc.
  2. GET /services/vectors/ → extract 41 direction URL
  3. GET /services/cure/ → extract 243 procedure URLs
  4. Для каждого direction: GET → extract price table
  5. Для каждой procedure: GET → extract price table

Результат: ~294 URL с прайсами
  → ~168 страниц с ценами (69%)
  → ~900 unique услуг после дедупликации
```

### 6.5. Parser strategy: css_class + 2 формата таблиц

**Format 1: `table-price` (~80% страниц)**
```html
<table class="table-price">
  <tr>
    <td>Прием (осмотр, консультация) врача-кардиолога первичный</td>
    <td><div class="price">3 000<span>руб.</span></div></td>
  </tr>
</table>
```

**Format 2: `table_min` (~20%, стоматология)**
```html
<table class="table_min">
  <tr><td colspan="2">Приёмы специалистов</td></tr>  <!-- заголовок секции -->
  <tr>
    <td>Приём врача-стоматолога-терапевта первичный</td>
    <td>1 200 ₽</td>
  </tr>
  <tr>
    <td>Лечение кариеса</td>
    <td>от 6&nbsp;500 ₽</td>                           <!-- "от" = минимальная цена -->
  </tr>
</table>
```

**Extraction logic:**
1. Найти `table.table-price` → Format 1
   - Для каждого `<tr>`: первый `<td>` = name, второй `<td>` = price
   - priceRaw = "3 000" + "<span>руб.</span>"
2. Найти `table.table_min` → Format 2
   - Пропустить `<tr>` с `colspan` (заголовки секций)
   - Для остальных `<tr>`: первый `<td>` = name, второй `<td>` = price
   - Если price содержит "от" → isMinPrice = true
   - Декодировать `&nbsp;` перед parsePrice()
3. ExternalId = normalize(name) (нет stable ID)
4. Category = заголовок секции (для Format 2) или breadcrumb

### 6.6. Дедупликация

```yaml
deduplication:
  key: normalize(name)
  priority: cure > vector > other
  note: |
    Та же услуга встречается на vector-странице и cure-подстранице.
    Пример: "Регистрация электрокардиограммы" 700 руб. есть на:
      /services/vectors/kardiologiya/ (700 руб.)
      /services/cure/elektrokardiogramma-ekg/ (700 руб.)
    Цены одинаковые → берём с cure-страницы (более специфичной).
```

### 6.7. Специфические особенности

| Особенность | Решение |
|---|---|
| **294 страницы** | BFS discovery (sitemap неполный) |
| **2 формата таблиц** | Parser: table-price + table_min |
| **`colspan` заголовки секций** | Пропускать `<tr>` с colspan |
| **"от" минимальные цены** | isMinPrice = true |
| **`&nbsp;` в ценах** | Декодировать перед parsePrice() |
| **31% страниц без прайса** | Health-aware: 0 items → следующий URL |
| **Дубликаты услуг** | dedupeByExternalId (normalize name) |
| **Нет stable ID** | externalId = normalize(name) |

### 6.8. Validation rules (Altamed+-specific)

```yaml
validation:
  min_items: 500           # после дедупа ожидаем ~900
  max_items: 2000
  price_range: [100, 500000] # RUB
  pages_with_price_ratio: 0.65  # 69% страниц имеют прайс
  allow_zero_items_per_page: true  # 31% страниц информационные
  alert_if_pages_with_prices_drops_below: 120
```

### 6.9. Fixture requirements

```
src/scraper/parsers/__test__/fixtures/
  ├── altamed-kardiologiya.html  ⬜ TODO (table-price, 11 услуг)
  ├── altamed-stomatology.html   ⬜ TODO (table_min, 16 услуг с "от")
  ├── altamed-cure-ekg.html      ⬜ TODO (table-price, 3 услуги)
  └── altamed-no-price.html      ⬜ TODO (страница без прайса)
```

### 6.10. Текущий статус

- ⬜ Не реализован (только разведка)
- ⬜ BFS discovery: не реализован
- ⬜ Parser: 2 формата таблиц не реализованы
- ⬜ Fixture: нет

**Что нужно сделать:**
1. Fetch `/services/vectors/kardiologiya/` → fixture (table-price)
2. Fetch `/services/stomatology/` → fixture (table_min)
3. Адаптировать parser для 2 форматов таблиц
4. Реализовать BFS discovery
5. Прогнать scrape-run с maxUrls=10

---

## 7. Конкурент 6: Medsi (medsi.ru)

### 7.1. Архитектура сайта

| Характеристика | Значение |
|---|---|
| **Framework** | Битрикс + Vue SSR-фрагменты |
| **Tier** | Hybrid T1 (services) + T3 (labmarket) |
| **Framework detection** | `class="bx-core"` + `data-v-` attrs |
| **SSR** | Да (Vue SSR fragments) |
| **Schema.org** | Нет |
| **Currency** | "руб." (словом) |
| **Anti-bot** | Нет |
| **Sitemap** | `https://medsi.ru/sitemap.xml` → 2 sub-sitemaps, ~9 739 URL |
| **robots.txt** | **`Disallow: /*clinic=`**, **`Disallow: /*?`** (критично!) |

### 7.2. URL structure

```
/services/{slug}/                    ← клиническая услуга (SEO-блок)
/labmarket/service/{slug}/           ← анализ SmartLab (SPA, требует JS)
/clinics/{slug}/                     ← клиника (информация)

Примеры:
  /services/priem-terapevta/
  /labmarket/service/achtv/
```

### 7.3. Region strategy: `none` (SEO-блок уже агрегирует)

```yaml
region_strategy:
  type: none
  note: |
    Medsi: 63 клиники в Москве + 17 городов-поддоменов.
    robots.txt запрещает ?clinic= (нельзя получить цены по конкретной клинике).
    Решение: собираем только min-цены из SEO-блока.
    SEO-блок уже агрегирует по всем клиникам Москвы.
```

### 7.4. Discovery

```
Вход: https://medsi.ru/sitemap.xml → sitemap-0.xml + sitemap-1.xml

Discovery strategy: sitemap + URL filter
  1. fetch sitemap-0.xml (5 001 URL) + sitemap-1.xml (4 738 URL)
  2. filter: /services/{slug}/ → ~1 248 URL (клинические услуги)
  3. filter: /labmarket/service/{slug}/ → ~1 086 URL (анализы)
  4. filter out: /doctors/, /articles/, /clinics/

Результат: ~2 334 URL для сбора
```

### 7.5. Parser strategy: seo_text_block (services) + T3 SPA (labmarket)

#### 7.5.1. Services — SEO text block (T1, plain HTML)

**HTML структура:**
```html
<p class="hdn">
  Прием специалиста:
  Диспансерный прием (осмотр, консультация) врача-терапевта - от 3000 руб.;
  Консультация врача-терапевта для оформления - от 1300 руб.;
  Прием (осмотр, консультация) врача-терапевта первичный - от 2700 руб.;
</p>
```

**Extraction logic:**
1. Найти `<p class="hdn">` после "Прием специалиста:" / "Услуги:" / "Описание услуг:"
2. Разбить текст по ";" → отдельные услуги
3. Для каждой услуги: regex `([^.]+?)\s*-\s*(?:от\s+)?(\d[\d\s]*)\s*руб\.`
   - Group 1 = nameRaw
   - Group 2 = priceRaw
   - Если есть "от" → isMinPrice = true

#### 7.5.2. Labmarket — SPA, page_reader required (T3)

**HTML структура (после JS):**
```html
<div class="lb-test__list-item">
  <a href="/labmarket/service/antitela-igg-k-koronavirusu-sars-cov-2-covid-19-kach/" class="lb-test__more-detail">
    Подробнее
  </a>
  <span class="lb-test__price-btn-mod">от</span>
  <span>1500 <span class=""> ₽</span></span>
</div>
```

**Individual labmarket page:**
```html
<div class="total-info_price">Цена: от 270 ₽*</div>
<div class="total-info_deadline_text">Срок исполнения: 1 календарный день...</div>
```

**Важно:** labmarket требует JS-execution. StaticFetcher получит пустой каталог.
Нужен PageReaderFetcher (z-ai SDK) или Playwright.

### 7.6. Специфические особенности

| Особенность | Решение |
|---|---|
| **robots.txt: `Disallow: /*clinic=`** | НЕ использовать `?clinic=` — нарушение robots.txt |
| **`Disallow: /*?`** | Все query-параметры запрещены |
| **63 клиники в Москве** | НЕ собираем цены по клиникам — только min-цены из SEO-блока |
| **SEO-блок = min-цены** | isMinPrice = true для всех Medsi items |
| **Vue `data-v-` attrs** | Игнорировать в regex (Vue SSR artifacts) |
| **`&nbsp;` как HTML entity** | Декодировать (не unicode \u00A0) |
| **labmarket = SPA** | Требует PageReaderFetcher (T3) |
| **2 sub-домена: services + labmarket** | Multi-strategy per competitor |

### 7.7. Multi-strategy per competitor

Medsi требует **2 разных стратегии** в одном конкурента:

```yaml
strategies:
  services:
    fetcher: static_curl       # T1, plain HTML
    parser: seo_text_block     # min-цены из <p class="hdn">
    discovery: sitemap         # /services/ URLs
    expected_items: ~1250

  labmarket:
    fetcher: page_reader       # T3, требует JS
    parser: css_class          # lb-test__price
    discovery: sitemap         # /labmarket/service/ URLs
    expected_items: ~1086
```

### 7.8. Validation rules (Medsi-specific)

```yaml
validation:
  min_items: 800           # services ~1250 + labmarket ~1086
  max_items: 3000
  price_range: [50, 500000] # RUB
  pages_with_price_ratio: 0.65  # не все /services/ имеют SEO-блок
  alert_if_seo_block_missing_on: 0.50  # если >50% страниц без SEO-блока → alert
```

### 7.9. Fixture requirements

```
src/scraper/parsers/__test__/fixtures/
  ├── medsi-therapist-seo.html      ⬜ TODO (/services/priem-terapevta/, SEO-блок)
  ├── medsi-gynecology-seo.html     ⬜ TODO (/services/gynecology/, 36 услуг в SEO-блоке)
  ├── medsi-labmarket-achtv.html    ⬜ TODO (/labmarket/service/achtv/, после JS)
  └── medsi-labmarket-index.html    ⬜ TODO (/labmarket/analyzes/, 60 топ-анализов)
```

### 7.10. Текущий статус

- ⬜ Services: SEO-block parser не реализован
- ⬜ Labmarket: T3 PageReaderFetcher не реализован
- ⬜ Fixture: нет
- ✅ robots.txt анализ: проведён, `?clinic=` запрещён

**Что нужно сделать:**
1. Fetch `/services/priem-terapevta/` через curl → fixture (SEO-блок)
2. Написать seo_text_block parser test
3. Для labmarket: использовать z-ai page_reader для рендера JS
4. Прогнать scrape-run отдельно для services и labmarket

---

## 8. Cross-competitor логика

### 8.1. Scope (region filtering)

```
Для каждого конкурента:
  1. Probe Engine определяет region_strategy
  2. Discovery фильтрует URL по matchesTargetRegion(url, region, regionStrategy)
  3. Validator проверяет snap.region === config.targetRegion
  4. Dashboard показывает "Регион: Московская область"

Текущий TARGET_REGION=mo (Московская область)
  → CMD: /msk/ URL'ы (цены одинаковы по РФ)
  → Gemotest: /moskva/ URL'ы
  → Helix: IP-based (нужен MSK proxy)
  → Veramed: все 3 тарифа (клиники в МО)
  → Altamed+: все URL (сеть в МО)
  → Medsi: SEO-блок (агрегирует по Москве)
```

### 8.2. Scheduling

```yaml
per-competitor schedule (PLANNED):
  cmd-online:
    cron: "0 3 * * *"        # ежедневно 03:00
    maxUrls: 50              # ~50 карточек в день
    tier: T1_schema_org

  gemotest:
    cron: "0 4 * * *"        # ежедневно 04:00
    maxUrls: 10              # 10 категорий × ~50 анализов = ~500 items
    tier: T1

  helix:
    cron: "0 5 * * *"        # ежедневно 05:00
    maxUrls: 10              # 10 страниц × 12 items = ~120 items
    tier: T2
    proxyRequired: true      # MSK residential proxy

  veramed:
    cron: "0 6 * * 1"        # понедельник 06:00 (1 URL = весь прайс)
    maxUrls: 1
    tier: T1

  altamed:
    cron: "0 7 * * 1"        # понедельник 07:00 (294 страницы)
    maxUrls: 50              # ~50 страниц в неделю
    tier: T1

  medsi-services:
    cron: "0 8 * * *"        # ежедневно 08:00
    maxUrls: 30              # 30 страниц в день
    tier: T1

  medsi-labmarket:
    cron: "0 9 * * *"        # ежедневно 09:00
    maxUrls: 20              # 20 страниц в день
    tier: T3
    fetcher: page_reader
```

### 8.3. Self-healing (PLANNED)

```
При каждом scrape-run:
  1. Health check:
     - itemsExtracted vs expectedMin
     - nullFieldsRate
     - structureDiff (htmlStructureHash vs previous)

  2. Если health fails:
     - trigger_reprobe → Probe Engine запускается заново
     - Сравнение новой spec с old
     - Если strategy та же, изменились селекторы → auto-update spec
     - Если strategy изменилась → human review

  3. Alert в Telegram:
     - "Spec for {competitor} auto-updated, reason: {reason}"
     - "Scrape failed for {competitor}, items dropped {N}%"
```

### 8.4. Alerts

| Триггер | Severity | Канал |
|---|---|---|
| Scrape run failed | warning | Telegram |
| items < minItems 3× подряд | warning | Telegram |
| Hard block (403/429) | critical | Telegram + email |
| Цена изменилась >30% | info | Telegram |
| Fallback T1→T8 (VLM) | warning | Telegram + GitHub Issue |
| Spec auto-updated | info | Telegram |

### 8.5. Cross-source matching (PLANNED)

```
Одна и та же услуга на разных сайтах называется по-разному:
  CMD:      "Глютен (клейковина), IgE"
  Gemotest: "Глютен (клейковина), Ig E"
  Helix:    "Глютен, IgE"

Решение: LLM-embedding'и для сопоставления
  1. Для каждого service: compute embedding(name)
  2. findCrossSourceMatches(name, allServices): similarity > 0.85
  3. Создать ServiceMatch (competitorA.serviceId ↔ competitorB.serviceId)
  4. Dashboard: "Общий анализ крови: CMD 820₽, Gemotest 890₽, Helix 835₽"
```

---

## 9. Приоритет реализации

### 9.1. Текущий статус (после M1 + M2 prep)

| Конкурент | Probe | Discovery | Parser | Fixture | Test | Scrape | Статус |
|---|---|---|---|---|---|---|---|
| **CMD** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **DONE** |
| **Gemotest** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | not started |
| **Helix** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | not started |
| **Veramed** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | not started |
| **Altamed+** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | not started |
| **Medsi** | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | not started |

### 9.2. Рекомендуемый порядок (по complexity × value)

| Порядок | Конкурент | Сложность | Value | Почему |
|---|---|---|---|---|
| 1 | **CMD** | Low | High | ✅ DONE — эталон, Schema.org |
| 2 | **Gemotest** | Medium | High | T1, data-eec-*, много услуг, нет антибота |
| 3 | **Veramed** | Low | Medium | T1, 1 URL = весь прайс, тривиальный discovery |
| 4 | **Altamed+** | Medium | Medium | T1, но 2 формата таблиц + BFS discovery |
| 5 | **Helix** | Medium | High | T2, embedded JSON, нужен proxy для MSK |
| 6 | **Medsi** | High | High | Hybrid T1+T3, robots.txt ограничения, SPA |

### 9.3. DoD для каждого конкурента

```
- [ ] Probe Engine запущен, ProbeResult сохранён
- [ ] Discovery находит URL с ценами
- [ ] Fixture сохранён (HTML карточки/категории)
- [ ] Parser test написан (offline, ≥5 assertions)
- [ ] Scrape-run: status=success, itemsExtracted > 0
- [ ] /api/services возвращает сохранённые услуги
- [ ] /api/prices возвращает price snapshots
- [ ] Validation rules настроены per-competitor
- [ ] Worklog обновлён
```

---

## 10. Сводная таблица конкурентов

| Конкурент | Tier | Fetcher | Parser | Region | URL count | Items | Объём | Proxy? |
|---|---|---|---|---|---|---|---|---|
| CMD | T1+Schema.org | static_curl | schema_org | url_path_segment | 1 510 | 1 510 | 123 МБ | No |
| Gemotest | T1 | static_curl | data_attributes | url_prefix | 66 | ~3 300 | 26 МБ | No |
| Helix | T2 | static_curl | embedded_json | ip_default | 90 | 1 078 | 22 МБ | Yes (MSK) |
| Veramed | T1 | static_curl | css_class | tariff_select | 1 | 3 261 | 3.4 МБ | No |
| Altamed+ | T1+discovery | static_curl | css_class (2 formats) | none | ~294 | ~900 | 82 МБ | No |
| Medsi services | T1 | static_curl | seo_text_block | none | 1 248 | ~1 250 | 488 МБ | No |
| Medsi labmarket | T3 | page_reader | css_class | none | 1 086 | 1 086 | 382 МБ | No |
| **ИТОГО** | | | | | **~5 295** | **~11 385** | **~1.1 ГБ** | |

---

*Документ описывает логику работы со всеми 6 конкурентами. Для каждого указаны:
архитектура, метод сбора, URL discovery, parser strategy, region handling,
специфические особенности, validation rules, fixture requirements и текущий статус.
Обновляется по мере реализации каждого конкурента.*
