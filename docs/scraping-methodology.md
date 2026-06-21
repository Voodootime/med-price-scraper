# Универсальный скрапер медицинских прайсов — методология

> **Главная цель:** построить универсальный движок, способный автоматически
> собирать данные о ценах и услугах с **любого** медицинского сайта — независимо
> от архитектуры, фреймворка, способа хранения данных и наличия антибот-защиты.
> Движок **сам** определяет тип сайта, выбирает оптимальный метод сбора,
> обнаруживает страницы с ценами, выводит унифицированную структуру и
> самовосстанавливается при изменении вёрстки.
>
> Документ уровня senior fullstack + devops. Описывает автоопределение тиров,
> стратегии discovery, адаптивный парсинг, AI-ассистентов (VLM/LLM) и операционные
> практики. Разведанные сайты (Veramed, Gemotest, Helix, Altamed+, Medsi, CMD)
> используются как **эталонные кейсы** для валидации универсальности движка.

---

## 0. Scope сбора (бизнес-ограничение — НЕ изменять без согласования)

### 0.1. Принцип

Система отслеживает цены **только в одном выбранном географическом регионе**:
либо конкретный город (например, Москва), либо Московская область целиком.
**Полная федеральная тарифная сетка конкурента не собирается.**

### 0.2. Обоснование

1. **Бизнес-смысл:** конкурентное ценообразование локально. Цены Gemotest в
   Новосибирске не релевантны для клиники в Одинцово.
2. **Этическое:** меньшая нагрузка на сайты конкурентов. Сбор 1 города вместо 17
   снижает трафик в 17 раз.
3. **Юридическое:** минимизация объёма собираемых данных снижает риски претензий
   по ToS.
4. **Cost:** VLM/Playwright нужны только в fallback; минимальный сбор = минимальный
   бюджет на прокси и AI Skills.

### 0.3. Target regions (по умолчанию)

| Регион | Что входит | Заметка |
|---|---|---|
| **Москва** (город) | ЦАО, САО, ВАО, ЮАО, СВАО, ЮВАО, ЗАО, СЗАО, ЮЗАО, ТАиО, ЗелАО | Основной регион для большинства федеральных сетей |
| **Московская область** | Города МО: Одинцово, Долгопрудный, Балашиха, Химки, Мытищи, Красногорск, Реутов, Домодедово, и т.д. | Для региональных клиник (Veramed, Altamed+) |

**Конфигурация region** задаётся через переменную окружения `TARGET_REGION` и
хранится в БД (`AppConfig.targetRegion`). Смена региона = миграция данных
(старые snapshot'ы остаются, новые собираются с другим scope).

### 0.4. Влияние на архитектуру

#### 0.4.1. Унифицированный фильтр на уровне Fetcher

Каждый Fetcher получает `region: Region` параметр. На уровне spec-схемы для
каждого конкурента определён `region_strategy` — как применить регион к URL:

```yaml
region_strategy:
  type: url_path_segment     # auto-detected (см. раздел 2)
  param: city_slug
  mapping:
    moscow: msk
    spb: sankt-peterburg
    mo: ""
```

Поддерживаемые типы region_strategy (выявлены из разведанных сайтов):

| Тип | Пример | Где применяется |
|---|---|---|
| `url_prefix` | `/{city}/catalog/...` | Gemotest |
| `url_path_segment` | `/catalog/{city}/{slug}/` | CMD |
| `url_subdomain` | `https://{city}.medsi.ru/...` | Medsi |
| `url_query` | `/services/x/?clinic={slug}` | Medsi (клиники Москвы) — **запрещено robots.txt** |
| `cookie` | `Cookie: cityId={id}` | Helix |
| `ip_default` | SSR определяет по IP | Helix (нельзя изменить без прокси) |
| `tariff_select` | Вкладка тарифа в HTML | Veramed (3 тарифа клиник МО) |
| `none` | Регион не влияет | Altamed+ (одна локация — МО) |

**Все типы auto-detectable** через Probe Engine (см. раздел 2).

#### 0.4.2. Хранение region в данных

```prisma
model PriceSnapshot {
  // ...
  region       String   @default("moscow")  // moscow | mo | spb | ...
  locationKey  String?  // gemotest: "moskva"; medsi: "klinika-na-leninskom"; veramed: "premium"
  // ...
  @@index([serviceId, region, scrapedAt])
}
```

`locationKey` — детализация внутри региона (конкретная клиника/тариф/категория).
Для большинства конкурентов = `null` (одна цена на регион). Для Medsi — slug
клиники в Москве. Для Veramed — название тарифа.

#### 0.4.3. Пересмотр нагрузки (ТОЛЬКО целевой регион)

| Сайт | Без scope (вся РФ) | Со scope (1 регион) | Снижение |
|---|---|---|---|
| Veramed | 1 URL × 3 тарифа = 3 261 услуг | 1 URL × 3 тарифа МО = **3 261 услуга** (Veramed — уже только МО) | 0% (уже локальный) |
| Gemotest | 66 URL × ~17 городов = ~56 000 услуг | 66 URL × 1 город = **~3 300 услуг** | **-94%** |
| Helix | 90 URL × SSR по IP (только СПб из РФ-сервера) | 90 URL = **1 078 услуг** для одного города | 0% (нужен прокси для других городов) |
| Altamed+ | 294 страницы | 294 страницы (только МО) = **~900 услуг** | 0% (уже локальный) |
| Medsi services | 1 248 × 63 клиники = ~78 000 страниц | 1 248 × **1 город (SEO-блок)** = **~1 250 услуг** | **-98%** |
| Medsi labmarket | 1 086 × 17 городов | 1 086 × 1 город = **1 086 анализов** | **-94%** |
| CMD | 132 866 URL (86 городов) | 1 510 URL (msk) = **1 510 анализов** | **-99%** (цены одинаковы по городам) |

**Итог: с scope-фильтром полный сбор = ~11 385 позиций вместо ~80 000+.**
Объём трафика: ~1.1 ГБ вместо ~5+ ГБ.

#### 0.4.4. Политика для много-клиниковых сетей (Medsi)

Для Medsi в пределах Москвы доступно 63 клиники, но:
- `?clinic=` запрещён в robots.txt
- SEO-блок даёт только min-цену по всем клиникам Москвы

**Решение:** собираем min-цены из SEO-блока. Если для конкретной услуги
критична цена по конкретной клинике → ручной lookup через UI (не в scope
автоматического сбора).

#### 0.4.5. Мультигородность на будущее

Если бизнес-требования изменятся и понадобится несколько регионов:
1. Добавить `targetRegions: []` в AppConfig (вместо одного `targetRegion`)
2. Scheduler запускает N параллельных job'ов — по одному на регион
3. Каждый job использует свой `region_strategy` mapping
4. **Не удалять** старые snapshot'ы — они остаются как исторические данные

Это расширение заложено в архитектуру, но **не реализуется в MVP**.

### 0.5. Антипаттерны (запрещено)

1. ❌ Собирать цены по всем городам «на всякий случай» — нарушение scope
2. ❌ Использовать `?clinic=` для Medsi даже если очень хочется — нарушение robots.txt
3. ❌ Менять `TARGET_REGION` без миграции БД (старые snapshot'ы привязаны к старому region)
4. ❌ Хранить цены без поля `region` — невозможно сопоставить данные
5. ❌ Смешивать в одном scrape-run два региона — данные нельзя сравнивать между собой
6. ❌ Писать парсер под конкретный сайт без auto-detection — движок должен быть universal

### 0.6. Валидация scope в pipeline

```typescript
// В FetcherOptions — обязательное поле
interface FetcherOptions {
  region: Region;            // 'moscow' | 'mo' | 'spb' | ...
  locationKey?: string;      // детализация внутри региона
  // ...
}

// В Validator — проверка консистентности
function validateSnapshot(snap: PriceSnapshot, config: AppConfig): ValidationResult {
  if (snap.region !== config.targetRegion) {
    return { ok: false, error: 'Region mismatch: snapshot.region != config.targetRegion' };
  }
  // ...
}
```

---

## 1. Главная цель: универсальный движок с автоопределением

### 1.1. Принцип

Движок не требует ручного написания spec-схемы под каждый сайт. При добавлении
нового конкурента (URL главной) движок **сам**:

1. **Probe** — анализирует главную страницу, определяет технологии
2. **Detect tier** — классифицирует сайт (T1-T10) по поведению
3. **Discover price URLs** — находит страницы с ценами (sitemap, BFS, search)
4. **Infer schema** — выводит структуру данных (CSS / data-attrs / JSON / Schema.org)
5. **Generate spec** — создаёт YAML-схему автоматически, помечает как `auto_generated`
6. **Validate** — прогоняет тестовый сбор, проверяет полноту
7. **Self-heal** — при падении парсера пытается перестроить селекторы

Человек может вмешаться на любом этапе: принять spec, подправить селекторы,
запретить某些 URL. Но **по умолчанию движок автономен**.

### 1.2. Почему это важно

- **Масштабируемость:** добавление 10-го конкурента = 1 клик в UI, а не 2 дня работы инженера
- **Устойчивость:** при изменении вёрстки движок сам перестраивает селекторы (с AI-помощью)
- **Качество:** единая унифицированная модель данных, независимо от источника
- **Cost:** 80% сайтов попадают в T1-T2 (auto-detectable без AI), VLM нужен только для edge cases

### 1.3. Эталонные кейсы для валидации универсальности

Разведанные сайты используются как **тестовые фикстуры** для движка. Если движок
не может автоматически определить тир и сгенерировать spec для каждого из них —
архитектура недостаточно универсальна.

| Сайт | Ожидаемый auto-detect | Что проверяем |
|---|---|---|
| veramed-clinic.ru | T1, `tariff_select`, 1 URL = весь прайс | Много блоков с `hidden` атрибутом |
| gemotest.ru | T1, `url_prefix`, 66 сабкатегорий | `data-eec-*` атрибуты |
| helix.ru | T2, `ip_default`, embedded JSON `G.json./api/` | JSON-блобы в SSR HTML |
| altamedplus.ru | T1+discovery, 2 формата таблиц, BFS-crawl | Распределённый прайс по ~294 страницам |
| medsi.ru | Hybrid T1+T3, SEO-блок + SPA labmarket | Multi-strategy per competitor |
| cmd-online.ru | T1+Schema.org, `url_path_segment`, 1510 URL | Schema.org микроразметка |

---

## 2. Probe Engine — автоопределение характеристик сайта

При добавлении нового сайта (через UI или API) движок запускает **probe
sequence** — серию диагностических запросов для определения характеристик.

### 2.1. Probe pipeline

```
new competitor URL
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. Fetch robots.txt                                          │
│    → sitemap URLs, Disallow rules, crawl-delay              │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. Fetch homepage (curl + page_reader, compare)              │
│    → framework (Bitrix/WordPress/Angular/Vue/React/Next)    │
│    → SSR vs SPA (diff between curl и page_reader)           │
│    → embedded JSON blobs (__NEXT_DATA__, G.json./api/, etc) │
│    → Schema.org microdata presence                          │
│    → currency symbols (₽, руб., р.)                         │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. Fetch sitemap(s)                                          │
│    → URL count, categorization by path patterns             │
│    → identify catalog/services/clinics sub-trees            │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. Probe catalog page (sample 3-5 URLs from sitemap)        │
│    → price extraction attempts (5 strategies, see 2.3)      │
│    → success rate per strategy                              │
│    → data richness (price/code/term/category availability)  │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. Detect region_strategy                                   │
│    → URL patterns with city slugs                           │
│    → cookie/header tests with different regions            │
│    → subdomain checks                                       │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 6. Tier classification (see 2.4)                            │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 7. Generate spec.yaml (auto, marked auto_generated: true)   │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 8. Test scrape (10 URLs) + validation                       │
│    → if pass: spec becomes active                           │
│    → if fail: queue for human review or VLM-assist          │
└──────────────────────────────────────────────────────────────┘
```

### 2.2. Framework detection heuristics

```typescript
interface ProbeResult {
  framework: 'bitrix' | 'wordpress' | 'drupal' | 'next' | 'nuxt' | 'angular'
           | 'vue' | 'react-spa' | 'tilda' | 'custom' | 'unknown';
  isSSR: boolean;              // server-side rendering
  hasEmbeddedState: boolean;   // __NEXT_DATA__, window.__INITIAL_STATE__, G.json./api/
  hasSchemaOrg: boolean;       // itemprop="price"
  robotsTxt: ParsedRobots;
  sitemapUrls: string[];
  currencyFormat: '₽' | 'руб.' | 'р.' | 'rub' | 'mixed';
  detectedLanguages: string[];
  antiBotHints: {
    cloudflare?: boolean;
    recaptcha?: boolean;
    jsChallenge?: boolean;
    rateLimitHeaders?: string[];
  };
}
```

Detection patterns:

| Признак | Вывод |
|---|---|
| `class="bx-core"` / `/bitrix/` в asset paths | Bitrix |
| `__NEXT_DATA__` script | Next.js (React SSR) |
| `__NUXT__` / `window.__NUXT__` | Nuxt.js (Vue SSR) |
| `ng-version` / `_nghost-` / `_ngcontent-` | Angular |
| `data-v-` attrs (hash) | Vue (no SSR) |
| `data-reactroot` | React (no SSR) |
| `tilda` в meta generator | Tilda |
| `wp-content/` / `wp-includes/` | WordPress |
| `cdn-cgi/challenge-platform` | Cloudflare challenge (T6) |
| `g-recaptcha` / `data-sitekey` | reCAPTCHA (T7) |

### 2.3. Price extraction strategies (5 подходов)

Для каждой страницы пробуем **по очереди**, пока не получим ≥1 валидных цен:

```typescript
const PRICE_STRATEGIES: PriceStrategy[] = [
  // #1 — Schema.org microdata (эталон)
  {
    name: 'schema_org',
    priority: 1,
    regex: /<span[^>]*itemprop="price"[^>]*>([^<]+)<\/span>/,
    currencyRegex: /<meta[^>]*itemprop="priceCurrency"[^>]*content="([^"]+)"/,
    successOn: 'cmd-online.ru'
  },
  // #2 — data-eec-* / data-price / data-product-price attributes
  {
    name: 'data_attributes',
    priority: 2,
    regex: /data-(?:eec-)?price="([^"]+)"/,
    successOn: 'gemotest.ru'
  },
  // #3 — embedded JSON state (Next/Nuxt/Angular SSR)
  {
    name: 'embedded_json',
    priority: 3,
    regex: /"G\.json\.\/api\/[^"]+"\s*:\s*\{"body":(\{)|__NEXT_DATA__[^>]*>(\{)/,
    parser: 'json_path',
    successOn: 'helix.ru'
  },
  // #4 — CSS class patterns (cheerio)
  {
    name: 'css_class',
    priority: 4,
    // auto-discovered via class name heuristics: any class containing 'price'
    selectorCandidates: ['.price', '.product-price', '.service-price', '.analyze-item__price', '*[class*="price"]'],
    successOn: 'altamedplus.ru, veramed-clinic.ru'
  },
  // #5 — SEO text block (минимальные цены)
  {
    name: 'seo_text_block',
    priority: 5,
    regex: /(?:Прием специалиста|Услуги|Описание услуг)[:\s]*([\s\S]+?)<\/p>/,
    itemPattern: /([^.]+?)\s*-\s*(?:от\s+)?(\d[\d\s]*)\s*руб\./,
    successOn: 'medsi.ru'
  },
  // #6 — VLM last resort (screenshot → vision model)
  {
    name: 'vlm_screenshot',
    priority: 99,
    cost: 'high',
    description: 'Делаем screenshot страницы, VLM извлекает JSON с ценами',
    successOn: 'future T8 sites'
  }
];
```

**Stop condition:** первая стратегия, давшая ≥N валидных цен (N=5 по умолчанию),
становится основной. Остальные — fallback'и в spec.yaml.

### 2.4. Tier classification matrix

После probe движок определяет тир по матрице признаков:

| Признак | → Тир |
|---|---|
| `hasSchemaOrg && priceFound` | **T1+Schema.org** (highest quality, curl only) |
| `framework=='bitrix' && pricesInHTML` | **T1 static** (curl + cheerio) |
| `hasEmbeddedState && pricesInJSON` | **T2 SSR+state** (curl + JSON extract) |
| `isSSR==false && pricesInXHR` | **T3 SPA+API** (page_reader или Playwright intercept) |
| `isSSR==false && !pricesInXHR` | **T4 SPA без API** (Playwright full render) |
| `lazyLoadDetected && !paginationURLs` | **T5 lazy/infinite** (Playwright + scroll) |
| `antiBot.cloudflare` | **T6 light antibot** (stealth + residential proxy) |
| `antiBot.recaptcha \|\| antiBot.datadome` | **T7 heavy antibot** (mobile proxy + VLM) |
| `pricesAsImage || canvasRendered` | **T8 visual** (screenshot → VLM) |
| `pdfPriceListDetected` | **T9 PDF** (pdf-parse + LLM normalization) |

### 2.5. Region strategy detection

Движок автоматически определяет, как сайт привязывает цены к региону:

```typescript
function detectRegionStrategy(probe: ProbeResult, sitemapUrls: string[]): RegionStrategy {
  // #1 — путь содержит slug города
  const citySlugsInPath = findCitySlugsInPaths(sitemapUrls);
  if (citySlugsInPath.length > 3) {
    return { type: 'url_path_segment', candidates: citySlugsInPath };
  }
  
  // #2 — URL префикс /{city}/...
  const cityPrefixes = findCityPrefixes(sitemapUrls);
  if (cityPrefixes.length > 3) {
    return { type: 'url_prefix', candidates: cityPrefixes };
  }
  
  // #3 — поддомены {city}.example.ru
  const subdomains = findCitySubdomains(probe);
  if (subdomains.length > 0) {
    return { type: 'url_subdomain', candidates: subdomains };
  }
  
  // #4 — cookie / header test (запрос с разными Cookie: cityId=N)
  const cookieStrategy = await probeCookieRegion(probe);
  if (cookieStrategy) {
    return { type: 'cookie', ...cookieStrategy };
  }
  
  // #5 — IP-based (если cookie не меняют цены, но цены в HTML зависят от гео)
  if (probe.pricesVaryByIP) {
    return { type: 'ip_default', note: 'Требует прокси для смены региона' };
  }
  
  // #6 — тарифы внутри HTML (вкладки/табы)
  if (probe.hasTariffTabs) {
    return { type: 'tariff_select' };
  }
  
  return { type: 'none' };
}

// Словарь известных slug'ов городов РФ
const KNOWN_CITY_SLUGS = new Set([
  'msk', 'moskva', 'spb', 'sankt-peterburg', 'ekb', 'ekaterinburg',
  'nn', 'nizhniy-novgorod', 'nsk', 'novosibirsk', 'kzn', 'kazan',
  // ... ~300 slug'ов
]);
```

---

## 3. Discovery Engine — поиск страниц с ценами

После определения тира движок ищет **все URL, содержащие цены**.

### 3.1. Discovery strategies (по приоритету)

```typescript
const DISCOVERY_STRATEGIES: DiscoveryStrategy[] = [
  // #1 — Sitemap (самый надёжный)
  { name: 'sitemap', priority: 1, fetchRobotsTxt: true, parseSitemapIndex: true },
  
  // #2 — HTML link analysis на homepage + ключевых разделах
  { name: 'link_analysis', priority: 2, maxDepth: 2 },
  
  // #3 — BFS crawl от ключевых разделов
  { name: 'bfs_crawl', priority: 3, maxDepth: 3, linkPattern: 'auto' },
  
  // #4 — Поиск через web-search (z-ai SDK) — "site:example.ru прайс"
  { name: 'web_search', priority: 4, queries: ['прайс', 'цены', 'стоимость'] },
  
  // #5 — Common path probing (/price, /prices, /price-list, /uslugi, /services)
  { name: 'common_paths', priority: 5, paths: ['/price/', '/prices/', '/price-list/', '/uslugi/', '/services/', '/catalog/'] },
  
  // #6 — VLM-assisted: screenshot homepage → "найди ссылки на прайс"
  { name: 'vlm_assisted', priority: 99, cost: 'high' }
];
```

### 3.2. Sitemap discovery (приоритет #1)

```typescript
async function discoverViaSitemap(baseUrl: string): Promise<DiscoveredUrl[]> {
  // 1. robots.txt → sitemap URLs
  const robots = await fetchRobotsTxt(baseUrl);
  let sitemapUrls = robots.sitemaps;
  
  // 2. Если в robots нет — пробуем стандартные пути
  if (sitemapUrls.length === 0) {
    sitemapUrls = [
      `${baseUrl}/sitemap.xml`,
      `${baseUrl}/sitemap_index.xml`,
      `${baseUrl}/sitemaps/sitemap.xml`
    ].filter(url => await urlExists(url));
  }
  
  // 3. Рекурсивно парсим sitemap index'ы
  const allUrls: string[] = [];
  for (const smUrl of sitemapUrls) {
    const urls = await parseSitemap(smUrl);  // recursively
    allUrls.push(...urls);
  }
  
  // 4. Категоризация URL по path patterns
  return categorizeUrls(allUrls);
}

function categorizeUrls(urls: string[]): DiscoveredUrl[] {
  return urls.map(url => ({
    url,
    category: classifyUrl(url),  // 'catalog' | 'service' | 'clinic' | 'doctor' | 'article' | 'other'
    hasCitySegment: detectCitySegment(url),
    depth: url.split('/').length - 3,
  }));
}

function classifyUrl(url: string): UrlCategory {
  const path = new URL(url).pathname;
  if (/\/(services|uslugi|cure|vectors)\//.test(path)) return 'service';
  if (/\/(catalog|katalog|analizy)\//.test(path)) return 'catalog';
  if (/\/(clinics|filialy|branches)\//.test(path)) return 'clinic';
  if (/\/(doctors|vrachi|specialists)\//.test(path)) return 'doctor';
  if (/\/(articles|blog|news|press)\//.test(path)) return 'article';
  return 'other';
}
```

### 3.3. BFS crawl (fallback, для сайтов без sitemap)

```typescript
async function discoverViaBFCrawl(seedUrls: string[], options: CrawlOptions): Promise<DiscoveredUrl[]> {
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = seedUrls.map(url => ({ url, depth: 0 }));
  const discovered: DiscoveredUrl[] = [];
  
  while (queue.length > 0 && discovered.length < options.maxUrls) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    
    if (depth > options.maxDepth) continue;
    
    const html = await fetch(url);
    const links = extractLinks(html, url);  // только internal, same-domain
    
    for (const link of links) {
      if (matchesPattern(link, options.linkPattern)) {
        discovered.push({ url: link, category: classifyUrl(link), depth: depth + 1 });
        queue.push({ url: link, depth: depth + 1 });
      }
    }
    
    await delay(options.rateLimitMs);  // politeness
  }
  
  return dedupe(discovered);
}
```

### 3.4. Price URL filtering

После discovery у нас может быть 10 000+ URL. Нужно отфильтровать только те,
где реально есть цены:

```typescript
async function filterPriceUrls(urls: DiscoveredUrl[], probe: ProbeResult): Promise<PriceUrl[]> {
  // #1 — heuristic filter по path pattern
  const candidates = urls.filter(u => 
    u.category === 'catalog' || u.category === 'service' || 
    /price|pricelist|cost/i.test(u.url)
  );
  
  // #2 — sample N URLs, проверяем наличие цены через probe
  const sample = sampleN(candidates, 10);
  const probeResults = await Promise.all(
    sample.map(async url => ({
      url,
      hasPrice: await probeHasPrice(url, probe.primaryStrategy)
    }))
  );
  
  const successRate = probeResults.filter(r => r.hasPrice).length / sample.length;
  
  // #3 — если >70% sample содержит цены — берём все кандидаты
  //      если 30-70% — нужна донастройка (human review)
  //      если <30% — strategy не подходит, пробуем следующую
  if (successRate > 0.7) {
    return candidates.map(url => ({ ...url, expected: true }));
  } else if (successRate > 0.3) {
    return candidates.map(url => ({ ...url, expected: 'uncertain' }));
  } else {
    return [];  // trigger next strategy
  }
}
```

---

## 4. Schema inference — автоматическое понимание структуры

Даже если мы знаем, что цены есть, нужно понять **структуру** (где name, где
price, где category, где code). Движок использует 3 подхода:

### 4.1. Heuristic-based (быстрый, без AI)

```typescript
function inferSchemaHeuristic(html: string, strategy: PriceStrategy): InferredSchema {
  // Для Schema.org — структура задана стандартом
  if (strategy.name === 'schema_org') {
    return {
      price: 'itemprop="price"',
      currency: 'itemprop="priceCurrency"',
      name: 'itemprop="name"',
      availability: 'itemprop="availability"',
      // стандартизировано, не нужно угадывать
    };
  }
  
  // Для data-attrs — анализируем все data-* рядом с ценой
  if (strategy.name === 'data_attributes') {
    const priceElem = findElementWithAttr(html, /data-(?:eec-)?price=/);
    const siblings = getSiblings(priceElem);
    return {
      price: 'data-eec-price',
      name: findAttrInSiblings(siblings, /data-(?:eec-)?name/),
      code: findAttrInSiblings(siblings, /data-(?:eec-)?id/),
      category: findAttrInSiblings(siblings, /data-(?:eec-)?sec/),
    };
  }
  
  // Для CSS-классов — ищем классы по ключевым словам
  if (strategy.name === 'css_class') {
    return {
      price: findClassContaining(html, ['price', 'cost']),
      name: findClassContaining(html, ['name', 'title'], nearElement: priceElem),
      code: findClassContaining(html, ['code', 'art', 'sku']),
      category: findClassContaining(html, ['category', 'section', 'rubric']),
    };
  }
  
  // ...
}
```

### 4.2. LLM-assisted (для сложных случаев)

Если эвристики не хватает (например, нет явных классов с "price"), движок
отправляет **фрагмент HTML** в LLM с промптом:

```
Дан HTML фрагмент карточки товара с медицинского сайта.
Извлеки CSS-селекторы для полей:
- name (название услуги)
- price (цена, число)
- currency (валюта)
- category (категория, если есть)
- code (артикул/код, если есть)

Верни JSON: { "name": "...", "price": "...", ... }
Только CSS-селекторы, без объяснений.

HTML:
<div class="med-service-block__type-item">
  <div class="med-service-block__type-item-name">Прием терапевта</div>
  <div class="med-service-block__type-item-price-num">
    <span>1 300 <span class="rub">руб.</span></span>
  </div>
</div>
```

LLM возвращает:
```json
{
  "name": "div.med-service-block__type-item-name",
  "price": "div.med-service-block__type-item-price-num span:first-child",
  "currency": "span.rub"
}
```

Результат кэшируется (по хешу HTML-фрагмента) — повторные запросы к тому же
сайту не требуют LLM.

### 4.3. VLM-assisted (последний рубеж)

Если LLM не смогла разобрать HTML (например, цены отрисованы canvas'ом или
защищены обфускацией):

```
1. Playwright делает screenshot страницы
2. VLM получает screenshot + промпт:
   "Извлеки JSON-массив услуг с этой страницы. 
    Каждая услуга: {name, price, category}. 
    Верни только JSON."
3. Ответ валидируется Zod-схемой
4. При успехе — auto-создаётся тикет "VLM fallback сработал, нужна human review"
```

### 4.4. Schema confidence score

Каждая inferred schema получает **confidence score** (0-100):

| Фактор | Баллы |
|---|---|
| Schema.org microdata | +40 |
| data-* атрибуты с явным `price` в имени | +30 |
| Стабильный ID (code, hxid, cat-id) | +20 |
| Цена извлечена на 95%+ sample страниц | +20 |
| Найдена категория/секция | +10 |
| LLM-выведенная схема | -10 (требует валидации) |
| VLM-выведенная схема | -30 (требует валидации) |

- **≥70** → spec автоматически активируется
- **40-69** → spec помечается `needs_review`, прогоняется тестовый сбор, человек подтверждает
- **<40** → сайт не добавляется, алерт "требуется ручная разборка"

---

## 5. Adaptive parser — самовосстановление

Сайты меняются. Движок должен **замечать** поломку парсера и пытаться
самостоятельно перестроить селекторы.

### 5.1. Health check на каждый scrape

```typescript
interface ScrapeHealth {
  itemsExtracted: number;
  expectedMin: number;       // из spec
  nullFieldsRate: number;    // % полей = null
  htmlStructureHash: string; // sha256(canonicalize(html))
  structureDiff: number;     // % diff с прошлым успешным сбором
}

function evaluateHealth(health: ScrapeHealth, spec: Spec): HealthAction {
  // Happy path
  if (health.itemsExtracted >= health.expectedMin && 
      health.nullFieldsRate < 0.1 &&
      health.structureDiff < 0.1) {
    return { action: 'proceed' };
  }
  
  // Вёрстка сильно изменилась
  if (health.structureDiff > 0.3) {
    return { action: 'trigger_reprobe', reason: 'html_structure_changed' };
  }
  
  // Мало items — возможно, селекторы сломались
  if (health.itemsExtracted < health.expectedMin * 0.5) {
    return { action: 'trigger_reprobe', reason: 'items_count_dropped' };
  }
  
  // Много null-полей — структура изменилась частично
  if (health.nullFieldsRate > 0.3) {
    return { action: 'trigger_partial_reprobe', reason: 'fields_missing' };
  }
  
  return { action: 'proceed_with_warning' };
}
```

### 5.2. Auto-reprobe flow

При триггере `trigger_reprobe` движок:

1. **Не удаляет** старую spec, помечает её `deprecated: true`
2. Запускает **полный probe pipeline** (раздел 2) заново
3. Сравнивает новую spec с old:
   - Если strategy та же, изменились только селекторы → auto-update spec
   - Если strategy изменилась (например, сайт переехал с T1 на T3) → human review
4. Прогоняет test scrape, сравнивает с историческими данными:
   - Если цены в ±20% от прошлых — ок, новая spec валидна
   - Если разброс >20% — алерт, возможно новая spec парсит другой тип цен (min vs конкретная)
5. Уведомление в Telegram: «spec для {competitor} auto-updated, причина: {reason}»

### 5.3. Selector A/B testing

При сомнениях (confidence 40-69) движок может **параллельно** прогнать 2 версии
селекторов и сравнить результаты:

```typescript
async function abTestSelectors(url: string, specA: Spec, specB: Spec): Promise<Spec> {
  const [resultA, resultB] = await Promise.all([
    parseWithSpec(url, specA),
    parseWithSpec(url, specB)
  ]);
  
  // Тот, который дал больше валидных items с меньшим nullFieldsRate — победитель
  const scoreA = resultA.items.length * (1 - resultA.nullFieldsRate);
  const scoreB = resultB.items.length * (1 - resultB.nullFieldsRate);
  
  return scoreA >= scoreB ? specA : specB;
}
```

---

## 6. Universal data model

Независимо от источника, движок выводит **единую структуру**:

```typescript
interface UniversalPriceItem {
  // === Идентификация ===
  externalId: string;          // stable ID (cat-NNNN, hxid, code, slug)
  externalIdType: 'cat_id' | 'hxid' | 'code' | 'slug' | 'name_hash';
  code?: string;               // человеко-читаемый код (3.9.1., 02-005, 100002)
  slug?: string;               // URL slug
  
  // === Содержание ===
  name: string;                // canonical name (после normalize)
  nameRaw: string;             // как на сайте (до нормализации)
  category?: string;           // категория/раздел
  section?: string;            // топ-уровень (если есть)
  description?: string;
  biomaterial?: string;
  estimatedDays?: string;      // срок исполнения
  method?: string;             // метод исследования
  
  // === Цена ===
  price: number;               // в копейках (для точности) или рублях с Decimal
  priceRaw: string;            // "1 300 ₽", "от 530 р.", "3 000 руб."
  currency: string;            // ISO 4217: RUB
  isMinPrice: boolean;         // true если "от X" (минимальная)
  marketPrice?: number;        // старая цена (для скидок)
  discountPct?: number;
  
  // === Scope ===
  region: string;              // 'moscow' | 'mo' | 'spb'
  locationKey?: string;        // детализация внутри региона
  tariff?: string;             // для Veramed
  
  // === Metadata ===
  url: string;                 // canonical URL
  available: boolean;          // in stock?
  bonuses?: number;            // бонусы (Gemotest)
  scrapedAt: Date;
  competitorId: string;
  rawHtmlS3Key?: string;       // ссылка на raw-lake
  parseStrategy: string;       // 'schema_org' | 'data_attrs' | 'embedded_json' | ...
  parseConfidence: number;     // 0-100
}
```

### 6.1. Normalization layer

Между парсером и БД — слой нормализации:

```typescript
class Normalizer {
  normalize(item: UniversalPriceItem): NormalizedItem {
    return {
      ...item,
      name: this.normalizeName(item.nameRaw),         // trim, lowercase, collapse spaces
      price: this.normalizePrice(item.priceRaw),      // "1 300 ₽" → 1300
      currency: this.normalizeCurrency(item.currency), // RUB
      category: this.normalizeCategory(item.category), // canonical
      // ...
    };
  }
  
  // LLM-нормализация названий (кэшированная)
  async normalizeNameWithLLM(name: string): Promise<string> {
    const cached = await this.cache.get(`name:${hash(name)}`);
    if (cached) return cached;
    
    const canonical = await this.llm.invoke({
      prompt: `Приведи название медицинской услуги к каноническому виду. 
               Удали лишние слова ("прием", "осмотр", "консультация" оставить).
               Верни только каноническое название.
               Вход: "${name}"`
    });
    
    await this.cache.set(`name:${hash(name)}`, canonical, TTL_30_DAYS);
    return canonical;
  }
}
```

### 6.2. Cross-source deduplication

Одна и та же услуга на разных сайтах называется по-разному. Движок использует
**LLM-embedding'и** для сопоставления:

```typescript
async function findCrossSourceMatches(name: string, allServices: Service[]): Promise<Match[]> {
  const nameEmbedding = await embed(name);  // z-ai embeddings API
  
  const matches = allServices
    .map(s => ({
      service: s,
      similarity: cosineSimilarity(nameEmbedding, s.embedding)
    }))
    .filter(m => m.similarity > 0.85)
    .sort((a, b) => b.similarity - a.similarity);
  
  return matches;
}
```

Это позволяет строить **сравнительные таблицы** между конкурентами: "Общий анализ
крови: Gemotest 890₽, Helix 835₽, CMD 820₽, Medsi 1300₽ min".

---

## 7. Pipeline: probe → detect → discover → parse → validate → store

Полный конвейер для нового конкурента:

```
[1] Add competitor (URL) ─────────────────────────────────────────┐
                                                                  │
[2] Probe Engine ─────────────────────────────────────────────────┤
    │  • fetch robots.txt                                         │
    │  • fetch homepage (curl + page_reader)                      │
    │  • detect framework, SSR, Schema.org, currency              │
    │  • fetch + parse sitemap                                    │
    │  • sample 5 catalog URLs, test price strategies             │
    │  • detect region_strategy                                   │
    │  • classify tier (T1-T10)                                   │
    ├─────────────────────────────────────────────────────────────┤
    │  Output: ProbeResult + TierClassification                   │
    │                                                              │
[3] Discovery Engine ─────────────────────────────────────────────┤
    │  • sitemap → all URLs                                       │
    │  • categorize URLs (catalog/service/clinic/other)           │
    │  • filter price URLs (sample + probe)                       │
    │  • apply region_strategy filter (scope=moscow)              │
    ├─────────────────────────────────────────────────────────────┤
    │  Output: PriceUrl[] (filtered by region)                    │
    │                                                              │
[4] Schema Inference ─────────────────────────────────────────────┤
    │  • heuristic schema (для schema_org, data_attrs)            │
    │  • LLM-assisted (если эвристики недостаточно)               │
    │  • VLM-assisted (последний рубеж)                           │
    │  • compute confidence score                                 │
    ├─────────────────────────────────────────────────────────────┤
    │  Output: InferredSchema + confidence                        │
    │                                                              │
[5] Spec Generation ──────────────────────────────────────────────┤
    │  • generate spec.yaml (auto_generated: true)                │
    │  • if confidence >= 70 → active                             │
    │  • if 40-69 → needs_review (human approval)                 │
    │  • if < 40 → rejected (manual investigation)                │
    ├─────────────────────────────────────────────────────────────┤
    │  Output: Spec (active | needs_review | rejected)            │
    │                                                              │
[6] Test Scrape ──────────────────────────────────────────────────┤
    │  • fetch 10 sample URLs                                     │
    │  • parse with new spec                                      │
    │  • validate (Zod + business rules)                          │
    │  • compute success rate                                     │
    ├─────────────────────────────────────────────────────────────┤
    │  Output: TestScrapeReport                                   │
    │                                                              │
[7] First Full Scrape ────────────────────────────────────────────┤
    │  • enqueue all filtered URLs to BullMQ                      │
    │  • parallel workers (concurrency from spec)                 │
    │  • per-URL: fetch → parse → normalize → validate            │
    │  • store to Postgres + raw to MinIO                         │
    ├─────────────────────────────────────────────────────────────┤
    │  Output: First batch of PriceSnapshots                      │
    │                                                              │
[8] Ongoing Scrapes (per cron schedule) ──────────────────────────┤
    │  • health check per scrape                                  │
    │  • if health fails → trigger_reprobe (раздел 5)             │
    │  • diff with previous → create PriceSnapshot only on change │
    │  • alerts on price changes >threshold                       │
    └─────────────────────────────────────────────────────────────┘
```

---

## 8. AI Skills — где используем

| Skill | Когда | Cost-aware правило |
|---|---|---|
| **Web-Reader** (z-ai page_reader) | Probe Engine: сравнение curl vs page_reader для SSR/SPA детекции | Только на probe (1-2 запроса на сайт) |
| **Web-Search** | Discovery fallback: "site:example.ru прайс" если sitemap пуст | Только если sitemap + BFS дали <10 URL |
| **LLM** (z-ai chat) | Schema inference для сложных CSS-структур; нормализация названий услуг | Кэшировать по хешу входа, TTL 30 дней |
| **VLM** (z-ai vision) | T8 fallback: screenshot → JSON с ценами; только если все остальные стратегии дали 0 | Hard limit: 10 VLM запросов на сайт в день |
| **Image-Generation** | Не используется | — |
| **TTS/ASR** | Не используется | — |

**Cost guard rails:**
- VLM: max 100 запросов/день на всю систему (alert при превышении)
- LLM: max 1000 запросов/день (кэш съедает 90% повторов)
- Web-Search: max 50 запросов/день
- Web-Reader: max 500 запросов/день (только probe + T3 labmarket)

---

## 9. Evaluation — как меряем качество движка

### 9.1. Метрики auto-detection

| Метрика | Цель | Как меряем |
|---|---|---|
| Tier detection accuracy | ≥95% | На 6 эталонных кейсах: совпадает ли auto-tier с разведанным? |
| Region strategy detection | ≥90% | На 6 кейсах: правильный ли `region_strategy`? |
| Schema inference success rate | ≥80% | Spec confidence ≥70 без human intervention |
| False positive rate (цены не оттуда) | <5% | Sample 100 items, ручная проверка |

### 9.2. Метрики runtime

| Метрика | Цель |
|---|---|
| Items extracted per scrape (vs expected) | ≥95% |
| Null fields rate | <10% |
| Parse duration p95 | <2с на страницу (T1) / <10с (T3-T8) |
| Self-heal success rate | ≥70% (без human intervention) |
| Cost per competitor per month (AI Skills) | <500₽ |

### 9.3. Regression test suite

Для каждого эталонного сайта — **фикстура** (исторический HTML из raw-lake):
при изменении парсера прогоняем все фикстуры, проверяем что экстракция не
сломалась. CI падает, если regression detected.

---

## 10. Специфика разведанных сайтов как валидационных кейсов

Разведанные сайты (Veramed, Gemotest, Helix, Altamed+, Medsi, CMD) используются
как **тестовые фикстуры** для валидации универсальности движка. Они покрывают
все основные тиры и паттерны:

| Кейс | Что валидирует |
|---|---|
| **Veramed** | T1 + `tariff_select` + много hidden-блоков в одном HTML |
| **Gemotest** | T1 + `url_prefix` + data-eec-* атрибуты |
| **Helix** | T2 + `ip_default` + embedded JSON `G.json./api/` |
| **Altamed+** | T1 + discovery (BFS-crawl) + 2 формата таблиц + дедупликация |
| **Medsi** | Hybrid (T1 SEO + T3 SPA) + multi-strategy per competitor |
| **CMD** | T1 + Schema.org + `url_path_segment` + одинаковые цены по городам |

Подробные spec-схемы для каждого — в Приложении B. Движок должен уметь
**автоматически** воспроизвести эти spec'и при подаче URL'а главной страницы.

---

## 11. Технологический стек (универсальный движок)

### 11.1. Core

| Слой | Технология | Зачем |
|---|---|---|
| Runtime | Node.js 20+ (LTS) / Bun | TS native, огромная экосистема |
| Language | TypeScript 5 strict | discriminated unions для Tier-стратегий |
| HTTP | `undici` (built-in fetch) | HTTP/2, proxy, retries |
| HTML parser | `cheerio` + `parse5` | стандарт; для скорости — `linkedom` |
| JSON extract | custom regex + `JSON.parse` | Для SSR-блобов |
| Browser | `playwright` | multi-browser, auto-wait, network-idle |
| Stealth | `playwright-extra` + stealth plugin | обход базовых fingerprint-проверок |
| Validation | `zod` | runtime-типы + TS-inference |
| Scheduler | `node-cron` (in-process) или BullMQ (distributed) | приоритеты, delayed jobs |
| Queue | BullMQ (Redis) | rate-limit per domain, retries |
| Object storage | MinIO (S3-compatible) | raw-data lake, screenshots |
| DB | PostgreSQL 16 через Prisma | time-series через гипертаблицы |
| Cache | Redis | content-hash, LLM-результаты |
| Logs | `pino` → Loki | структурированный JSON |
| Metrics | Prometheus + Grafana | counters, histograms |
| Tracing | OpenTelemetry → Jaeger | сквозной trace |
| Errors | Sentry | stack-traces, source-maps |
| Alerts | Telegram Bot | критические |

### 11.2. AI Skills (z-ai-web-dev-sdk)

| Skill | Когда |
|---|---|
| **VLM** | T8 fallback: screenshot → JSON |
| **LLM** | Schema inference для сложных CSS; нормализация названий; cross-source matching |
| **Web-Search** | Discovery fallback если sitemap пуст |
| **Web-Reader** | Probe Engine (curl vs page_reader comparison); T3 labmarket |

### 11.3. Anti-bot (для T6-T7)

| Слой | Технология |
|---|---|
| Proxy rotation | Bright Data / Oxylabs / Smartproxy |
| Mobile proxies | SOAX / IPRoyal Mobile (T7) |
| TLS spoofing | `curl-impersonate` (JA3 fingerprint) |
| HTTP/2 fingerprint | `got-scraping` |
| Captcha solver | 2Captcha / CapMonster |
| Fingerprint browser | `rebrowser-patches` |
| Behavior emulation | `ghost-cursor` для Playwright |

---

## 12. Politeness & антиблокировка

1. `robots.txt` уважается — `robots-parser` перед каждым fetch
2. Rate limit per domain: 1 req / 2 sec по умолчанию, spec переопределяет
3. `Retry-After` header — если сервер просит ждать, ждём
4. Exponential backoff: 1s → 2s → 4s → 8s → 16s, max 3 retries
5. User-Agent: реальный браузерный, ротация между 5-10 актуальными
6. Conditional requests: `If-Modified-Since`, `If-None-Match`
7. HTTP/2 по умолчанию
8. Jitter: random ±20% к задержке
9. Circuit breaker: 5 ошибок подряд → пауза 10 мин на домен

---

## 13. Resilient parsing — multi-selector fallback

В auto-generated spec.yaml:

```yaml
parsers:
  - name: primary
    selector: 'span[itemprop="price"]'
    confidence: 90
  - name: fallback_1
    selector: 'div.analyze-item__price'
    confidence: 70
    trigger: primary_items < expected * 0.5
  - name: fallback_2
    selector: 'div[class*="price"]'
    confidence: 50
    trigger: fallback_1_items < expected * 0.5
  - name: vlm_last_resort
    type: vlm_screenshot
    confidence: 30
    trigger: all_previous_failed
```

При каждом парсинге пробуем primary, если fails — fallback_1, и т.д. Каждый
fallback логируется с причиной. 3 отказа подряд → incident.

---

## 14. Data model (PostgreSQL/Prisma)

```
Region (1) ──── (N) AppConfig
                   │
Competitor (1) ─┬─ (N) Service ─ (N) PriceSnapshot  ← time-series
                │       │
                │       └─ (N) ServiceMatch (cross-source, LLM)
                │
                ├─ (N) ScrapeRun ─ (N) ScrapeAlert
                │
                ├─ (N) ScrapeSpec (версии, auto_generated: bool)
                │
                └─ (N) ProbeResult (история probe-запусков)
```

```prisma
model PriceSnapshot {
  id            Int      @id @default(autoincrement())
  serviceId     Int
  service       Service  @relation(fields: [serviceId], references: [id])
  price         Decimal  @db.Decimal(10, 2)
  pricePrevious Decimal? @db.Decimal(10, 2)
  deltaPct      Decimal? @db.Decimal(6, 2)
  currency      String   @default("RUB")
  region        String   @default("moscow")
  locationKey   String?
  isMinPrice    Boolean  @default(false)
  scrapedAt     DateTime @default(now())
  scrapeRunId   Int
  rawHtmlS3Key  String?
  parseStrategy String   // 'schema_org' | 'data_attrs' | 'embedded_json' | ...
  parseConfidence Int    @default(100)

  @@index([serviceId, region, scrapedAt])
  @@index([region, scrapedAt])
  @@unique([serviceId, region, locationKey, scrapeRunId])
}

model ScrapeSpec {
  id            Int      @id @default(autoincrement())
  competitorId  Int
  competitor    Competitor @relation(fields: [competitorId], references: [id])
  version       Int      // increment on each change
  specYaml      String   // full spec
  autoGenerated Boolean  @default(false)
  confidence    Int      @default(0)
  status        String   @default('active')  // active | needs_review | deprecated | rejected
  createdAt     DateTime @default(now())
  createdBy     String?  // user email or 'auto-detector'
  
  @@index([competitorId, status])
}

model ProbeResult {
  id            Int      @id @default(autoincrement())
  competitorId  Int
  competitor    Competitor @relation(fields: [competitorId], references: [id])
  probedAt      DateTime @default(now())
  framework     String
  tier          String   // T1-T10
  regionStrategy String
  sitemapUrlsCount Int
  priceUrlsCount   Int
  confidenceScore Int
  probeReportJson String  // full probe report
  
  @@index([competitorId, probedAt])
}
```

---

## 15. Observability

### 15.1. Метрики (Prometheus)

| Метрика | Тип | Зачем |
|---|---|---|
| `probe_runs_total{competitor,outcome}` | counter | auto-detection success rate |
| `tier_detected{tier}` | counter | распределение по тирам |
| `scrape_runs_total{competitor,status}` | counter | success rate |
| `scrape_duration_seconds{competitor,tier}` | histogram | latency p50/p95/p99 |
| `scrape_items_extracted{competitor}` | histogram | объём данных |
| `scrape_price_changes{competitor}` | counter | активность изменений |
| `scrape_blocks_total{competitor,reason}` | counter | 403/429/captcha |
| `scrape_fallback_used{competitor,from,to}` | counter | деградация стратегий |
| `scrape_raw_bytes{competitor}` | counter | трафик |
| `queue_depth{queue}` | gauge | backlog |
| `vlm_requests_total{competitor}` | counter | AI cost |
| `llm_requests_total{competitor,cache_hit}` | counter | AI cost + cache hit rate |
| `self_heal_triggered{competitor,reason}` | counter | resilience |
| `self_heal_success{competitor}` | counter | self-heal effectiveness |

### 15.2. Tracing (OpenTelemetry)

Один trace на scrape-run. Span'ы:
- `probe.run` (для новых конкурентов)
- `scheduler.dispatch`
- `queue.wait`
- `fetch.http` (URL, status, duration)
- `parse.{strategy}` (strategy, items, confidence)
- `normalize.llm` (если вызывался)
- `validate.zod`
- `store.upsert`
- `alert.dispatch`

### 15.3. Alerting

| Триггер | Канал | Severity |
|---|---|---|
| Probe failed for new competitor | Telegram | warning |
| Tier detection confidence <40 | Telegram + email | warning |
| Scrape run failed | Telegram | warning |
| items < minItems 3× подряд | Telegram | warning |
| Hard block (403/429) | Telegram + email | critical |
| Цена изменилась >30% | Telegram | info |
| Self-heal triggered | Telegram | info |
| Self-heal failed → human review needed | Telegram + Sentry | warning |
| VLM daily quota >80% | Telegram | warning |
| Worker OOM/restart | Sentry + PagerDuty | critical |

---

## 16. Cost model (с учётом scope — 1 регион, auto-detection)

При scope = 1 регион и автоопределении (5-10 конкурентов):

| Компонент | 5-10 конкурентов, ежедневный сбор | Стоимость/мес |
|---|---|---|
| VPS 2CPU/4GB в РФ (Москва) (scraper + worker) | 1 шт | ~2000₽ |
| PostgreSQL self-hosted на VPS | включено | 0 |
| Redis self-hosted на VPS | включено | 0 |
| MinIO self-hosted (50GB) | включено | 0 |
| Helix-Москва: residential proxy (5-10 ГБ/мес) | обязательно для Helix | ~1500-2500₽ |
| 2Captcha | только при T6-T7 (редко) | ~0-150₽ |
| VLM z-ai | только fallback (10-100 запросов/мес) | ~100-500₽ |
| LLM z-ai | schema inference + normalize, ~1000-5000 запросов/мес (кэш 90%) | ~300-1000₽ |
| Grafana Cloud free tier | метрики | 0 |
| Sentry developer | ошибки | 0 |
| **Итого MVP** | | **~4000-6000₽/мес** |

При расширении до 20-30 конкурентов:
- +1 VPS при росте: +2000₽
- +proxy на каждого с antibot: +1500₽/конкурент
- +VLM/LLM usage: +500-1500₽
- **Прогноз на 30 конкурентов: ~15000-20000₽/мес**

---

## 17. Roadmap реализации

### Phase 0 — Foundation & Scope (1 день)
- Зафиксировать `TARGET_REGION` в `.env`
- Prisma schema: Region, AppConfig, Competitor, Service, PriceSnapshot (с scope-полями),
  ScrapeRun, ScrapeSpec (с autoGenerated/confidence/status), ProbeResult
- Base interfaces: Fetcher, Parser, Normalizer, Validator, DiscoveryStrategy
- Health endpoint, structured logging (pino)
- Scope validation в Validator

### Phase 1 — Probe Engine (2-3 дня)
- Robots.txt parser (`robots-parser`)
- Sitemap fetcher (recursive, handles sitemapindex)
- Framework detector (heuristic patterns)
- SSR vs SPA detector (curl vs page_reader diff)
- Price strategy tester (5 strategies from 2.3)
- Region strategy detector (2.5)
- Tier classifier (matrix 2.4)
- ProbeResult → Spec generator (YAML output)
- **Validated on 6 эталонных кейсов** (Veramed/Gemotest/Helix/Altamed+/Medsi/CMD)

### Phase 2 — Discovery Engine (1-2 дня)
- Sitemap-based discovery (priority 1)
- BFS-crawl fallback (priority 3)
- URL categorization (catalog/service/clinic/doctor/other)
- Price URL filter (sample + probe)
- Region filter (apply scope)

### Phase 3 — Parsers (2-3 дня)
- Schema.org parser (T1+Schema.org) — для CMD
- Static HTML parser (cheerio) — для Veramed/Gemotest/Altamed+
- Embedded JSON parser — для Helix
- SEO-block parser — для Medsi services
- SPA renderer (page_reader) — для Medsi labmarket
- Multi-selector fallback (раздел 13)
- Zod-валидация per-strategy

### Phase 4 — Schema Inference (1-2 дня)
- Heuristic inference (для schema_org, data_attrs, css_class)
- LLM-assisted inference (z-ai chat SDK)
- Confidence score computation
- Spec auto-activation rules (≥70 auto, 40-69 review, <40 reject)
- **JS-extractor режим** (заимствовано из scraply, см. Приложение D):
  - опциональный `type: js_eval` в spec.yaml
  - sandboxed выполнение cheerio + пользовательских JS-выражений
  - для power-users, которым нужна точечная гибкость
- **Dev REPL shell** (заимствовано из scraply, см. Приложение D):
  - endpoint `/api/dev/shell` — отправляешь URL + extractors → получаешь результат
  - UI с Monaco editor: HTML слева, результат справа
  - cheerio исполняется на сервере, реальный-time feedback
  - ускоряет разработку spec'ов в 10 раз
- **Debug `return_body` режим** (заимствовано из scraply):
  - `ParseResult.debug.html` (опционально) — сырой HTML для debugging
  - `ParseResult.debug.domStats` — статистика DOM (totalElements, priceElements, scriptCount)

### Phase 5 — Normalizer (1 день)
- Price parser ("1 300 ₽" → 1300, "от 530 р." → 530 with isMinPrice=true)
- Name normalizer (trim, collapse spaces, lowercase)
- LLM name canonicalization (кэшированная)
- Cross-source matching (embeddings + cosine similarity)

### Phase 6 — Dashboard (2 дня)
- Список конкурентов с KPI (probe status, tier, last scrape, items count)
- Добавление конкурента → probe progress → spec review
- Графики динамики цен (Recharts) с разбивкой по region/locationKey
- Cross-source comparison table (через ServiceMatch)
- Детали scrape-run (лог, raw html ссылка, confidence)
- Индикатор scope в шапке: «Текущий регион: Московская область»
- Spec editor (YAML) с подсветкой и валидацией

### Phase 7 — Scheduler & alerts (1 день)
- BullMQ worker (concurrency, rate-limit, retries)
- Cron-spec в YAML
- Telegram-бот для алертов
- Diff-notifier: «цена на X (регион: MO) изменилась на Y%»

### Phase 8 — Self-healing (2 дня)
- Health check per scrape (раздел 5.1)
- Auto-reprobe trigger (раздел 5.2)
- Selector A/B testing (раздел 5.3)
- Self-heal metrics + alerts

### Phase 9 — VLM fallback (1 день)
- T8 стратегия
- Screenshot helper (playwright)
- z-ai VLM SDK интеграция
- Cost guard rails (10 запросов/сайт/день)

### Phase 10 — Hardening (1-2 дня)
- Raw-lake (MinIO) с retention
- OpenTelemetry tracing
- Prometheus metrics (все из 15.1)
- Regression test suite (фикстуры из 6 эталонных кейсов)
- CI: lint + tsc + parser tests на фикстурах

### Phase 11 — Production-ready
- Docker compose / K8s manifests
- **Multi-stage Docker builds** (заимствовано из scraply):
  - `Dockerfile.lean` — только T1/T2 (cheerio + JSON extract), ~50 МБ
  - `Dockerfile.full` — с Playwright для T3-T8, ~500 МБ
  - отдельные деплойменты для lean и full workers
- CI/CD pipeline
- Runbook для инцидентов
- Backup strategy для Postgres

---

## 18. Anti-patterns (чего НЕ делать)

1. ❌ Hardcoded селекторы в коде — только в spec-файлах
2. ❌ Spec per competitor без auto-detection — движок должен быть universal
3. ❌ `Float` для денег — только `Decimal`
4. ❌ Sync sleep в hot path — только Promise-based
5. ❌ Один try-catch на весь pipeline — per-stage
6. ❌ Логи без `traceId`
7. ❌ Puppeteer вместо Playwright
8. ❌ Без raw-lake — теряем возможность пере-парсинга
9. ❌ Retry без exponential backoff → гарантированный ban
10. ❌ Без robots.txt проверки
11. ❌ Selenium — устарел
12. ❌ BeautifulSoup/Scrapy (Python) — не тащить второй язык
13. ❌ Прямые запросы к DB из парсера — только через репозиторий
14. ❌ Magic numbers — все лимиты/timeout'ы в конфиге
15. ❌ VLM как primary стратегия — только fallback
16. ❌ Без confidence score — не знаем, можно ли доверять spec'у
17. ❌ Auto-generated spec без human override — всегда должна быть кнопка «edit spec»

---

## 19. Open questions

### Решённые

- ✅ Мультигородность: НЕ нужна (см. раздел 0)
- ✅ Хостинг: VPS в РФ обязателен
- ✅ Полная тарифная сетка Medsi: НЕ собирается
- ✅ Цель: универсальный движок с автоопределением (см. раздел 1)

### Открытые

1. Целевой регион = `moscow` или `mo`? (рекомендация: `mo`)
2. Нужны ли исторические графики за >1 года? (TimescaleDB)
3. Экспорт в Excel/Google Sheets — one-shot или по расписанию?
4. Авторизация в системе — один пользователь или команда с ролями?
5. Сопоставление с собственным прайсом — нужен справочник услуг?
6. Helix-Москва: требуется московский IP-прокси. Альтернатива: СПб-цены.
7. Бюджет на residential proxy — нужен ли вообще? (только для Helix-MSK)
8. Labmarket (SmartLab) Medsi — включать ли в сравнение с клиниками?
9. Срок исполнения есть только на labmarket/CMD. На /services/ — нет. ОК?

---

## Приложение A. Карта разведанных сайтов (с учётом scope — см. раздел 0)

| Сайт | Тир | URL прайса (для целевого региона) | Страниц | Услуг | Объём | region_strategy | Spec-готовность |
|---|---|---|---|---|---|---|---|
| veramed-clinic.ru | T1 | `/price/` | 1 | 3 261 (3 тарифа, все в МО) | 3.4 МБ | `tariff_select` (премиум/одинцово/звенигород) | High |
| gemotest.ru | T1 | `/moskva/catalog/...` (или `/{city}/catalog/...`) | 66 | ~3 300 (для одного города) | 26 МБ | `url_prefix` (moskva / spb / ...) | High |
| helix.ru | T2 | `/catalog/190-vse-analizy?page=N` | 90 | 1 078 (для города по IP) | 22 МБ | `ip_default` (требует прокси для смены) | High |
| altamedplus.ru | T1+discovery | `/services/**` (только МО — вся сеть локальная) | ~294 | ~900 (после дедупа) | 82 МБ | `none` (одна локация) | Medium |
| medsi.ru services | T1 | `/services/{slug}/` (SEO-блок, только min-цены Москвы) | 1 248 | ~1 250 (только min-цены по Москве) | ~488 МБ | `none` (SEO-блок уже агрегирует по Москве) | Medium-High |
| medsi.ru labmarket | T3 | `/labmarket/service/{slug}/` (требует JS) | 1 086 | 1 086 анализов (для Москвы) | ~382 МБ | `none` (SmartLab — единый прайс МСК) | Medium-High |
| cmd-online.ru | **T1+Schema.org** | `/analizy-i-tseny/katalog-analizov/{city}/{slug}_{code}/` | **1 510** | **1 510** анализов (для msk) | **~123 МБ** | **`url_path_segment`** (`msk` / `odintsovo` / ...) | **Highest** |

**Итого со scope:** ~4 295 страниц, ~11 385 позиций, ~1.1 ГБ трафика за полный сбор.

Эти сайты — **эталонные кейсы** для валидации универсальности движка (раздел 9).
Подробные spec-схемы — в Приложении B.

---

## Приложение B. Селекторы / паттерны (выжимка по эталонным кейсам)

Эти spec'и движок должен уметь **автоматически воспроизводить** при подаче URL'а
главной страницы (см. раздел 2 — Probe Engine).

### Veramed (T1)
```regex
tariff:    js-services-tab-content[^>]*data-id="([^"]+)"
category:  servicesCategory__title[^>]*>.*?<span>([^<]+)</span>
item:      <div class="js-service-item service__item"[^>]*>\s*<div class="services__name">(.*?)</div>\s*<div class="service__item-right">\s*<div class="services__price">([^<]+)</div>
```
Уникальный ключ: `(tariff, category, name)` — нет stable ID

### Gemotest (T1)
```regex
item:      data-eec-catalogid="([^"]*)"[^>]*?data-eec-name="([^"]*)"[^>]*?data-eec-id="([^"]*)"[^>]*?data-eec-price="([^"]*)"[^>]*?data-eec-sec="([^"]*)
```
Уникальный ключ: `(cat_id, city)` — стабильно

### Helix (T2)
```regex
json_blob: "G\.json\./api/catalog/items/list/v2[^"]+"\s*:\s*\{"body":(\{)
```
JSON-схема: `{ total: number, catalogItems: [{ id, hxid, title, price, marketPrice, currency, estimateInfo, isComplex }] }`
Уникальный ключ: `(hxid, cityId)` — стабильно, hxid человеко-читаемый (02-005)

### Altamed+ (T1 + discovery crawler)

**Discovery strategy:** BFS-обход от `/services/`:
1. `/services/` → список топовых разделов
2. `/services/vectors/` → 41 медицинское направление
3. `/services/cure/` → 243 индивидуальные процедуры
4. `/services/analysis_and_diagnostics/` → 4 диагностических раздела

**Два формата таблиц:**

Format 1 — `table-price` (основной, ~80% страниц):
```regex
<tr>\s*<td>\s*(.+?)\s*</td>\s*<td>\s*<div class="price">\s*(.+?)\s*<span>руб\.</span>\s*</div>\s*</td>\s*</tr>
```

Format 2 — `table_min` (стоматология, ~20% страниц):
```regex
<tr>\s*<td[^>]*>\s*(.+?)\s*</td>\s*<td[^>]*>\s*((?:от\s+)?[\d\s\u00A0]+₽)\s*</td>\s*</tr>
```

**Дедупликация:** `(normalized_name)`, приоритет `cure > vector > other`.

### Medsi (Hybrid T1 + T3)

**Strategies:**

1. `/services/**` (T1, plain HTML, SEO-блок):
```regex
context:  <p class="hdn">(Прием специалиста:|Услуги:|Описание услуг:)\s*(.+?)</p>
item:     ([^.]+?)\s*-\s*(?:от\s+)?(\d[\d\s]*)\s*руб\.
```

2. `/labmarket/**` (T3, SPA, page_reader):
```regex
context:  total-info_price
item:     Цена:\s*от\s*(\d[\d\s]*)\s*₽
```

**Критическое ограничение robots.txt:** `Disallow: /*clinic=`, `Disallow: /*?`
→ собираем только min-цены из SEO-блока.

### CMD Online (T1 + Schema.org microdata)

**Schema.org микроразметка (эталонный парсинг):**
```regex
price:     <span[^>]*itemprop="price"[^>]*>([^<]+)</span>
currency:  <meta[^>]*itemprop="priceCurrency"[^>]*content="([^"]+)"
available: <link[^>]*itemprop="availability"[^>]*href="([^"]+)"
name:      <h1[^>]*>([^<]+)</h1>
```

**Уникальное преимущество:** цены одинаковы по всем городам — собираем только `/msk/` (1 510 URL).

**Уникальный ключ:** `code` из URL (`_NNNNNN/`) или `slug`.

**Fetcher:** plain `curl` (85 КБ/страница, без JS).

---

## Приложение C. Spec.yaml — полный пример (auto-generated)

Пример spec.yaml, который Probe Engine должен сгенерировать для CMD:

```yaml
# Auto-generated by Probe Engine v1.0
competitor: cmd
base_url: https://www.cmd-online.ru
tier: T1_schema_org
auto_generated: true
confidence: 95
generated_at: 2025-01-15T10:30:00Z
generated_by: probe_engine

region_strategy:
  type: url_path_segment
  param: city_slug
  mapping:
    moscow: msk
    mo: msk           # цены одинаковы, проверено
  scope_optimization: 'Собираем только /msk/, цены едины по РФ'

discovery:
  type: sitemap
  sitemap_urls:
    - https://www.cmd-online.ru/sitemap.xml
  url_filter: '/analizy-i-tseny/katalog-analizov/msk/[^/]+/$'
  expected_pages: 1510

fetcher:
  type: static_curl
  user_agent: 'Mozilla/5.0 (compatible; PriceTracker/1.0)'
  rate_limit: 2s
  retries: 3
  backoff: exponential

parsers:
  - name: schema_org_primary
    type: schema_org
    priority: 1
    selectors:
      price: '<span[^>]*itemprop="price"[^>]*>([^<]+)</span>'
      currency: '<meta[^>]*itemprop="priceCurrency"[^>]*content="([^"]+)"'
      name: '<h1[^>]*>([^<]+)</h1>'
      availability: '<link[^>]*itemprop="availability"[^>]*href="([^"]+)"'
    confidence: 95

  - name: css_class_fallback
    type: css_class
    priority: 2
    trigger: 'schema_org_primary_items < expected * 0.5'
    selectors:
      price: 'div.analyze-item__price'
      name: 'div.analyze-item__title a'
      code: 'dd[data-code]'

  - name: vlm_last_resort
    type: vlm_screenshot
    priority: 99
    trigger: 'all_previous_failed'
    cost_guard: 'max 10 requests per day'

external_id:
  source: url_suffix
  fallback: slug

validation:
  min_items: 1500
  pages_with_price_ratio: 0.99
  price_range: [50, 100000]
  alert_thresholds:
    items_drop_pct: 50
    null_fields_rate: 0.3
    structure_diff: 0.3

schedule:
  cron: "0 3 * * *"
  timezone: Europe/Moscow

normalization:
  name_canonicalization: llm_cached
  cross_source_matching: embeddings
  
robots_compliance:
  respect_robots_txt: true
  disallowed_params: []
  crawl_delay: 2s
```

Аналогичные spec'и Probe Engine генерирует для всех остальных эталонных кейсов.

---

## Приложение D. Заимствования из scraply (github.com/alash3al/scraply)

> **Источник:** [scraply](https://github.com/alash3al/scraply) — микро-утилита
> на Go (129 stars, 2022) для извлечения данных из HTML через jQuery-подобный
> синтаксис. Не фреймворк, а простой extractor.
>
> Scraply — противоположность нашему подходу: он требует **ручного написания
> extractors**, наш движок делает **автоопределение**. Но у scraply есть 4
> сильные UX-идеи, которые мы интегрируем как опциональные расширения.

### D.1. Dev REPL Shell (Приоритет 1 — в Phase 4)

**Что позаимствовано:** интерактивный shell для разработки и отладки селекторов.

У scraply:
```bash
scraply shell -u https://example.com
➜ (scraply) > $("title").text()
"Example Domain"
```

**Наша адаптация (TypeScript + Next.js):**

Endpoint `POST /api/dev/shell`:
```typescript
// Request
{
  "url": "https://www.cmd-online.ru/analizy-i-tseny/katalog-analizov/msk/gluten/",
  "extractors": {
    "price": '$("span[itemprop=price]").text().trim()',
    "name": '$("h1").text()',
    "all_prices": '$("span[itemprop=price]").map((i,el)=>$(el).text()).get()'
  },
  "return_body": false
}

// Response
{
  "status": 200,
  "url": "https://www.cmd-online.ru/.../gluten/",
  "result": {
    "price": "810",
    "name": "Глютен (клейковина), IgE в Москве",
    "all_prices": ["810", "530", "1100"]
  },
  "html_size": 85280,
  "duration_ms": 1234,
  "body": null  // или HTML если return_body=true
}
```

**UI:** отдельная страница `/dev` с:
- **Monaco editor** слева (пишем extractors в JSON)
- **Результат** справа (JSON с подсветкой)
- **Поле URL** сверху + кнопка "Запустить"
- **History** последних 10 запросов (localStorage)
- **"Save as spec"** — конвертировать extractors в spec.yaml

**Реализация:** cheerio на сервере, sandboxed eval пользовательских JS-выражений
через `Function()` с ограниченным контекстом (только `$`, `request`, `response`).

### D.2. JS-extractor режим в spec.yaml (Приоритет 2 — в Phase 4)

**Что позаимствовано:** декларативный формат `key=script` — элегантнее, чем
статичные regex-селекторы.

**Наша адаптация — опциональный `type: js_eval` в parsers:**

```yaml
parsers:
  # Стандартный режим (regex-селекторы, как сейчас)
  - name: schema_org_primary
    type: schema_org
    priority: 1
    selectors:
      price: '<span[^>]*itemprop="price"[^>]*>([^<]+)</span>'
    confidence: 95

  # JS-extractor режим (новый, для power-users)
  - name: js_custom
    type: js_eval
    priority: 2
    trigger: 'schema_org_primary_items < expected * 0.5'
    extractors:
      price: '$("span[itemprop=price]").text().trim()'
      name: '$("h1[itemprop=name]").text()'
      code: |
        const m = window.location.pathname.match(/_(\d+)\/$/);
        return m ? m[1] : null;
      all_items: |
        $('.analyze-item').map((i, el) => ({
          name: $(el).find('.title').text().trim(),
          price: $(el).find('.price').text().trim()
        })).get();
    confidence: 80
```

**Sandbox:** выполняется в изолированном контексте, доступны только:
- `$` (cheerio instance загруженного HTML)
- `request` ({ url, method, headers })
- `response` ({ status, headers, body })
- `console` (перехватывается в лог)

**Безопасность:** запрещены `require`, `import`, `process`, `global`, `eval`.
Через `vm2` или `isolated-vm` для надёжной изоляции.

### D.3. Debug `return_body` режим (Приоритет 3 — в Phase 4)

**Что позаимствовано:** флаг `--return-body` в scraply для отладки.

**Наша адаптация — расширение `ParseResult`:**

```typescript
interface ParseResult {
  items: UniversalPriceItem[]
  strategy: PriceStrategyName
  confidence: number
  errors: string[]
  warnings: string[]
  rawHtmlS3Key?: string
  
  // НОВОЕ: debug-режим (только при scrapeRun.debug = true)
  debug?: {
    html?: string              // сырой HTML (только для dev)
    domStats?: {
      totalElements: number
      priceElements: number    // элементы с class*="price" или itemprop="price"
      scriptCount: number
      hasReact: boolean
      hasVue: boolean
      hasAngular: boolean
    }
    extractorTraces?: Array<{  // какие селекторы сработали
      name: string
      selector: string
      matched: number
      sampleValues: string[]
    }>
  }
}
```

Включается через `ScrapeRunContext.debug = true` — в этом случае парсер
сохраняет debug-инфу в S3 и возвращает в API-ответе. В production-режиме
по умолчанию off (для экономии памяти).

### D.4. Multi-stage Docker builds (Приоритет 4 — в Phase 11)

**Что позаимствовано:** `FROM scratch` образ scraply (2 МБ бинарник).

У нас Node.js + опционально Playwright, поэтому полный минимализм недостижим,
но можно разделить на 2 образа:

```dockerfile
# === Dockerfile.lean — для T1/T2 (большинство сайтов) ===
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && \
    npm prune --production
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
# Размер: ~150 МБ (вместо 500+ с Playwright)

# === Dockerfile.full — для T3-T8 (SPA, antibot, VLM) ===
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npx playwright install --with-deps chromium

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache chromium nss freetype harfbuzz
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/lib/chromium
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
# Размер: ~500 МБ
```

**Deployment:**
- `lean` workers — обрабатывают T1/T2 конкурентов (Veramed, Gemotest, CMD, Altamed+)
- `full` workers — обрабатывают T3+ конкурентов (Helix SPA, Medsi labmarket, будущие antibot)
- K8s: два Deployment'а с разными nodeSelectors

**Экономия:** 80% трафика обрабатывается lean-воркерами (150 МБ), только 20% требует full (500 МБ).

### D.5. Что НЕ заимствуем

| Идея scraply | Почему не берём |
|---|---|
| Go как язык | Наш стек TypeScript, cheerio ≠ goquery по API |
| Ручное написание extractors | Наш Probe Engine делает автоопределение — это главная фишка |
| Только T1 (static HTML) | Нам нужен T1-T10 |
| Отсутствие БД/scheduler/monitoring | У нас Prisma + BullMQ + pino + OTel |
| CLI-only интерфейс | У нас Web Dashboard |
| `goja` JS runtime | В Node.js JS нативный, через `vm2` |

### D.6. Резюме влияния на архитектуру

| Заимствование | Phase | Влияние на существующий код |
|---|---|---|
| Dev REPL shell | 4 | Новый endpoint `/api/dev/shell` + страница `/dev` |
| JS-extractor режим | 4 | Новый `type: js_eval` в Parser interface |
| `return_body` debug | 4 | Расширение `ParseResult.debug` |
| Multi-stage Docker | 11 | 2 Dockerfile + deployment strategy |

**Не ломает существующую архитектуру** — все 4 заимствования добавляются как
опциональные расширения. Probe Engine, Discovery, Parsers, Validator — работают
как прежде. JS-eval — просто ещё один `type` парсера.

---

*Документ описывает универсальный движок с автоопределением. Разведанные сайты
используются как эталонные кейсы для валидации универсальности. Scope сбора
зафиксирован в разделе 0 — изменение требует миграции БД. Заимствования из
scraply описаны в Приложении D — реализуются в Phase 4 и Phase 11.*

