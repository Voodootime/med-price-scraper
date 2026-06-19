# Методология скрапинга прейскурантов медицинских услуг

> Документ-конспект уровня senior fullstack + devops. Описывает классификацию
> целей, выбор стека, архитектуру конвейера, антидетект, observability и
> операционные практики. Является основой для реализации парсер-движка в проекте.

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
  type: url_prefix            # или url_query, cookie, ip_default, none
  param: city_slug            # имя параметра/префикса
  mapping:                    #(region → значение)
    moscow: moskva
    spb: sankt-peterburg
    mo: ""                    # пусто = дефолтная страница
```

| Стратегия | Пример | Где применяется |
|---|---|---|
| `url_prefix` | `/{city}/catalog/...` | Gemotest |
| `url_subdomain` | `https://{city}.medsi.ru/...` | Medsi (города-поддомены) |
| `url_query` | `/services/x/?clinic={slug}` | Medsi (клиники Москвы) — **запрещено robots.txt** |
| `cookie` | `Cookie: cityId={id}` | Helix |
| `ip_default` | SSR определяет по IP | Helix (нельзя изменить без прокси) |
| `tariff_select` | Вкладка тарифа в HTML | Veramed (3 тарифа клиник МО) |
| `none` | Регион не влияет | Altamed+ (одна локация — МО) |

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

**Итог: с scope-фильтром полный сбор = ~10 875 позиций вместо ~80 000+.**
Объём трафика: ~50 МБ вместо ~1 ГБ (для Medsi).

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

## 1. Классификация целей по тиру сложности

Прежде чем выбирать инструмент, цель классифицируется. От этого зависит весь
стек, бюджет и SLA сбора.

| Тир | Признаки | Инструмент | Latency / запрос | Цена / запрос |
|---|---|---|---|---|
| **T1 — Static HTML** | Серверный рендер, цены в DOM, нет lazy-load | `fetch` + `cheerio` / `linkedom` | 0.3–2 с | ~0 ₽ |
| **T2 — SSR + embedded state** | React/Angular/Vue SSR, данные в `__NEXT_DATA__` / `window.__INITIAL_STATE__` / `G.json./api/...` | `fetch` + JSON extraction | 0.5–3 с | ~0 ₽ |
| **T3 — SPA + JSON API** | XHR/fetch к REST/GraphQL, пагинация через query | `fetch` direct API (если доступен) или Playwright intercept | 0.3–2 с | ~0 ₽ |
| **T4 — SPA без API-доступа** | Данные появляются только после JS-execution, нет SSR | Playwright (chromium) | 3–15 с | ~0.001 ₽ |
| **T5 — Lazy-loaded / infinite scroll** | Контент подгружается по скроллу/клику | Playwright + scroll-emulation или per-page URLs | 5–30 с | ~0.005 ₽ |
| **T6 — Light antibot** | Cloudflare basic, rate-limit, JS-challenge | Playwright + stealth plugin + residential proxy | 10–60 с | ~0.05 ₽ |
| **T7 — Heavy antibot** | Datadome, PerimeterX, Kasada, Akamai, captcha | undetected-chromedriver + mobile proxy + VLM fallback | 30–180 с | ~0.5 ₽ |
| **T8 — Visual / canvas / image-based** | Цены отрисованы как картинки, обфусцированы | Playwright screenshot → **VLM** (z-ai-web-dev-sdk) | 15–60 с | ~0.1 ₽ |
| **T9 — PDF / DOCX / XLSX прайсы** | Файл вместо страницы | `pdf-parse` / `xlsx` / `mammoth` + LLM-нормализация | 1–10 с | ~0.02 ₽ |
| **T10 — Веб-сервисы (Telegram-боты, API)** | Цены только через interaction | `telegraf` + session storage | — | — |

### Текущая оценка наших трёх целей

| Сайт | Тир | Обоснование |
|---|---|---|
| `veramed-clinic.ru` | **T1** | Битрикс, статический HTML, все 3 261 услуги в одном ответе (часть с `hidden`) |
| `gemotest.ru` | **T1** | Битрикс, статический HTML, 66 сабкатегорий с `data-eec-price` атрибутами |
| `helix.ru` | **T2** | Angular 16 SSR, JSON-API ответы встроены как `"G.json./api/...": {"body": {...}}` |

Все три цели — T1/T2. Это значит, что для MVP **Playwright и VLM не нужны**.
Но архитектура обязана поддерживать T3-T8 как plug-in стратегии.

---

## 2. Принципы проектирования парсер-движка

### 2.1. Schema-first extraction

Каждый сайт описывается декларативной **spec-схемой** (YAML/JSON), а не кодом.
Парсер — это интерпретатор spec-схем. Это даёт:

- Добавление нового конкурента = правка YAML, без деплоя кода
- Версионирование схем (`schema_version`)
- A/B-тестирование новых селекторов без даунтайма
- Человеко-читаемая документация парсера

Пример spec-схемы (концепт):

```yaml
# specs/veramed.v1.yaml
competitor: veramed
base_url: https://veramed-clinic.ru
tier: T1
schedule: "0 3 * * *"          # ежедневно в 03:00
strategy: static_html
endpoints:
  - url: /price/
    parser:
      type: regex_grouped
      context_anchors:           # что считать «текущей категорией/тарифом»
        tariff: 'js-services-tab-content[^>]*data-id="([^"]+)"'
        category: 'servicesCategory__title[^>]*>.*?<span>([^<]+)</span>'
      item_pattern: |
        <div class="js-service-item service__item"[^>]*>\s*
        <div class="services__name">(.*?)</div>\s*
        <div class="service__item-right">\s*
        <div class="services__price">([^<]+)</div>
      fields:
        name: { group: 1, post: strip_tags }
        price_raw: { group: 2 }
        price: { from: price_raw, transform: parse_rub }
    unique_key: [tariff, category, name]
validation:
  min_items: 500                 # если меньше — alert
  price_range: [50, 1000000]     # ₽
  allow_zero_price: false
```

### 2.2. Multi-strategy с graceful degradation

Для каждой цели определён **fallback chain**. Если основная стратегия падает —
запускается следующая, более дорогая.

```
T1 (cheerio) → T2 (json-extract) → T4 (playwright DOM) → T8 (VLM screenshot)
```

Триггеры деградации:
- Извлечено 0 элементов (поломка вёрстки)
- Schema validation failed (Zod)
- HTTP 403/429 (блокировка)
- HTML hash резко изменился (>30% diff) — возможно редизайн

Каждый fallback логируется с причиной. На 3-й отказ подряд подряд —
incident в Sentry, алерт в Telegram.

### 2.3. Idempotency через content hash

Каждый сырой ответ получает `sha256(html)`. Если hash совпал с прошлым сбором —
парсинг пропускается, ценность: экономия CPU + стабильные данные.
Snapshot цены создаётся **только при изменении** price, не при каждом сборе.

```typescript
const hash = sha256(rawHtml);
if (hash === lastRun.contentHash) {
  return { status: 'unchanged', skipped: true };
}
```

### 2.4. Raw-data lake (immutable audit)

Сырой HTML/JSON сохраняется в S3-совместимое хранилище (MinIO локально):
```
s3://raw-scrape/{competitor}/{YYYY-MM-DD}/{HH-mm-ss}/{endpoint_slug}.html
```

Это даёт:
- Возможность пере-парсинга старых данных при исправлении багов парсера
- Аудит: «что именно отдал сайт в этот момент»
- Replay для тестов (фикстуры генерируются из реальных сборов)
- Защита от споров: «вы неправильно собрали» → вот сырой HTML

Retention: 90 дней горячего, 1 год в Glacier-классе.

### 2.5. Diff-based change detection

После парсинга сравниваем с предыдущим snapshot:
- **added**: новая услуга
- **removed**: услуга исчезла (всегда alert — возможно парсер сломан)
- **price_changed**: цена изменилась → создаём PriceSnapshot
- **renamed**: название изменилось, ID тот же → обновляем без snapshot

---

## 3. Технологический стек (рекомендация)

### 3.1. Core runtime

| Слой | Технология | Обоснование |
|---|---|---|
| Runtime | **Node.js 20+ (LTS)** / Bun | TypeScript native, V8 fast, огромная экосистема |
| Language | **TypeScript 5 (strict)** | Типизация схем, discriminated unions для Tier-стратегий |
| HTTP client | **`undici`** (built-in fetch) или `got` | HTTP/2, proxy, intercept, retries из коробки |
| HTML parser | **`cheerio`** + `parse5` | Де-факто стандарт, jQuery-подобный API |
| Fast HTML parser | **`linkedom`** | В 3-5× быстрее cheerio, DOMLiving-standard |
| JSON extraction | **custom regex + JSON.parse** | Для SSR-блобов (Helix-стиль) |
| Browser automation | **`playwright`** | Лучше Puppeteer: multi-browser, auto-wait, network-idle |
| Stealth | **`playwright-extra` + `puppeteer-extra-plugin-stealth`** | Обход базовых fingerprint-проверок |
| Schema validation | **`zod`** | Runtime-типы + TS-inference + читаемые ошибки |
| Cron/scheduler | **`node-cron`** (in-process) или **BullMQ** (distributed) | BullMQ если нужны очереди и retry |
| Queue / jobs | **BullMQ** (Redis) | Приоритеты, delayed jobs, repeatable, rate-limit |
| Object storage | **MinIO** (S3-compatible, self-hosted) | Raw-data lake, screenshots, PDFs |
| DB | **PostgreSQL 16** (через Prisma) | Структурированные данные, time-series через гипертаблицы |
| Time-series (optional) | **TimescaleDB** (PG extension) | Если snapshot-ов >10M, иначе обычный PG |
| Cache | **Redis** (один для очередей + cache) | Content-hash cache, rate-limit counters |
| Logs | **`pino`** + Loki | Структурированный JSON, быстрый, низкая аллокация |
| Metrics | **Prometheus** + Grafana | counters, histograms, alerting |
| Tracing | **OpenTelemetry** → Jaeger/Tempo | Сквозной trace: scheduler → fetch → parse → store |
| Errors | **Sentry** | Stack-traces, release-tracking, source-maps |
| Alerting | **Telegram Bot** + PagerDuty (опц.) | Критические — Telegram; инциденты — PagerDuty |

### 3.2. AI Skills (z-ai-web-dev-sdk)

Используются только на T8 и для нормализации названий:

| Skill | Когда применять |
|---|---|
| **VLM** | T8: цена отрисована картинкой/защищена; screenshot страницы → VLM извлекает JSON |
| **LLM** | Нормализация названий: «Приём терапевта первичный» ↔ «Консультация врача-терапевта первичная» → каноническое имя |
| **Web-Search** | Поиск URL прайса, если он не на главной (иногда `/price-list`, `/services/prices/`, `/price.html`) |
| **Web-Reader** | Quick-check новых сайтов без кода (как мы уже делали для разведки) |
| **TTS/ASR** | Не нужны в этом проекте |

**Cost-aware правило:** VLM-запрос = ~100× дороже cheerio. Запускаем только
если T1-T4 дали 0 валидных элементов И мы знаем, что сайт живой.

### 3.3. Anti-bot стек (на перспективу T6-T7)

| Слой | Технология | Заметка |
|---|---|---|
| Proxy rotation | **Bright Data / Oxylabs / Smartproxy** | residential обязательны для T6+ |
| Mobile proxies | **SOAX / IPRoyal Mobile** | T7 — мобильные IP, дороже но обходят всё |
| TLS spoofing | **`curl-impersonate`** | Подделка JA3 fingerprint под реальный Chrome |
| HTTP/2 fingerprint | **`got-scraping`** | HTTP/2 frame ordering как у браузера |
| Captcha solver | **2Captcha / CapMonster Cloud** | API, $2-3 за 1000 reCAPTCHA v2 |
| Fingerprint browser | **`rebrowser-patches`** | Патчит `navigator.webdriver`, CDP-детекции |
| Behavior emulation | **`ghost-cursor`** для Playwright | Человеко-подобные движения мыши |

---

## 4. Архитектура конвейера (pipeline)

### 4.1. Высокоуровневая схема

```
┌──────────────────────────────────────────────────────────────────┐
│  SCHEDULER (node-cron / BullMQ repeatable)                       │
│  - читает specs/*.yaml                                          │
│  - ставит job scrape:{competitor} в очередь                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  QUEUE (BullMQ / Redis)                                          │
│  - приоритеты, rate-limit per domain, delayed retry              │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  SCRAPER WORKER (stateless, горизонтально масштабируется)        │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ FETCHER  │→ │ PARSER   │→ │ NORMALIZER│→ │ VALIDATOR│         │
│  │ (tier-   │  │ (cheerio/│  │ (LLM для  │  │ (Zod +   │         │
│  │  aware)  │  │  json/   │  │  названий)│  │  бизнес- │         │
│  │          │  │  VLM)    │  │           │  │  rules)  │         │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘         │
│       │                                            │              │
│       │  raw html → S3                             │              │
│       │  metrics → Prometheus                      │              │
│       │  logs → pino → Loki                        │              │
│       │  traces → OTel → Jaeger                    │              │
└───────┼────────────────────────────────────────────┼─────────────┘
        │                                            │
        ▼                                            ▼
┌──────────────────────┐               ┌──────────────────────────┐
│  RAW LAKE (MinIO)    │               │  POSTGRES (Prisma)        │
│  /veramed/2025-01-15 │               │  - competitors            │
│    /03-00-00/price.. │               │  - services               │
│                      │               │  - price_snapshots        │
│  retention: 90d hot  │               │  - scrape_runs            │
└──────────────────────┘               │  - alerts                 │
                                       └──────────────────────────┘
                                                   │
                                                   ▼
                                       ┌──────────────────────────┐
                                       │  DASHBOARD (Next.js)     │
                                       │  - графики динамики      │
                                       │  - алерты                │
                                       │  - экспорт в xlsx         │
                                       └──────────────────────────┘
```

### 4.2. Этапы pipeline (детально)

#### 4.2.1. Fetcher

```typescript
interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;             // сырой ответ
  contentHash: string;      // sha256
  fetchedAt: Date;
  durationMs: number;
  tier: Tier;               // какая стратегия использовалась
  retries: number;
  proxyUsed?: string;
}

interface FetcherStrategy {
  tier: Tier;
  fetch(url: string, opts: FetchOptions): Promise<FetchResult>;
}
```

Стратегии:
- `StaticFetcher` (T1-T2): `undici.fetch` + retry + proxy rotation
- `PlaywrightFetcher` (T3-T5): `page.goto({waitUntil: 'networkidle'})`, опционально intercept XHR
- `StealthFetcher` (T6-T7): playwright-extra + stealth + residential proxy
- `VLMFetcher` (T8): screenshot → base64 → z-ai VLM SDK → JSON

#### 4.2.2. Parser

Получает `FetchResult` + spec-схему, возвращает `RawItem[]`:

```typescript
interface RawItem {
  externalId?: string;       // cat-NNNN, hxid, и т.п.
  code?: string;             // 3.9.1., 02-005, ...
  name: string;
  priceRaw: string;          // "1 234 ₽"
  price?: number;            // распарсенное
  marketPrice?: number;      // старая цена (Helix)
  category?: string;
  section?: string;          // топ-категория
  tariff?: string;           // для Veramed: премиум/одинцово/звенигород
  city?: string;             // для Gemotest: мск/спб/...
  biomaterial?: string;
  estimatedDays?: string;    // срок исполнения
  bonuses?: number;
  url?: string;              // ссылка на страницу услуги
  meta?: Record<string, unknown>;
}
```

#### 4.2.3. Normalizer

- Приводит названия к канонической форме через LLM (кэшировано по хешу названия)
- Сопоставляет с вашим внутренним справочником услуг
- Унифицирует единицы (дни → часы, рубли → копейки для точности)
- Резолвит дубли (один анализ в разных категориях)

#### 4.2.4. Validator

Zod-схема per-competitor + общие бизнес-правила:
- `price > 0`
- `price < 1_000_000` (медуслуги не бывают по 10M₽)
- `name.length >= 5`
- Кол-во items в диапазоне `[minItems, maxItems]` из spec
- Если валидация падает → fallback стратегии + alert

---

## 5. Politeness & антиблокировка (даже для T1)

Даже дружелюбные сайты (T1) могут забанить за агрессивность. Правила:

1. **`robots.txt` уважается** — `robots-parser` пакет, проверка перед каждым fetch
2. **Rate limit per domain**: не больше 1 запроса / 2 секунды по умолчанию, spec может переопределять
3. **`Retry-After` header** — если сервер просит подождать, ждём
4. **Exponential backoff**: 1s → 2s → 4s → 8s → 16s, max 3 retries
5. **User-Agent**: реальный браузерный UA, ротация между 5-10 актуальными
6. **Conditional requests**: `If-Modified-Since`, `If-None-Match` → экономия трафика, 304 не парсим
7. **HTTP/2** по умолчанию (один TCP-коннект на домен, мультиплексинг)
8. **Jitter**: random ±20% к задержке между запросами
9. **Backoff на 429/503**: минимум 60 секунд пауза + exponential
10. **Circuit breaker**: 5 ошибок подряд → пауза 10 минут на этот домен

---

## 6. Schema evolution & resilient parsing

Сайты меняются. Структура, классы, дата-атрибуты — всё течёт. Архитектура должна
**замечать** поломку, а не молча возвращать пустой массив.

### 6.1. Selector health checks

После каждого парса считаем:
- `itemsExtracted` — сколько элементов извлекли
- `expectedMin` / `expectedMax` — из spec
- `nullFieldsRate` — какой % полей null

Если `itemsExtracted < expectedMin` → **soft alert**, парсеру дают 3 попытки.
Если `nullFieldsRate > 30%` → **hard alert**, scrape помечается `degraded`.

### 6.2. HTML structure fingerprint

Каждый запуск считает fingerprint структуры:
```
hash(canonicalize(html))  →  убираем динамические токены (CSRF, timestamp, session)
```

Если fingerprint изменился >30% по сравнению с прошлым успешным сбором →
alert «возможно редизайн», человек смотрит.

### 6.3. Multi-selector fallback в spec

```yaml
item_pattern:
  primary: '<div class="js-service-item service__item"[^>]*>...'
  fallback_1: '<div class="service-item"[^>]*>...'
  fallback_2: '<div data-test="service-card"[^>]*>...'
```

Если primary даёт 0 элементов — пробуем fallback_1, и т.д. Каждый fallback
логируется, чтобы знать какой сработал.

### 6.4. VLM-last-resort

Если все селекторы дали 0 — последний рубеж: screenshot + VLM.
VLM получает prompt:
> "Извлеки JSON-массив услуг с этой страницы. Каждая услуга: {name, price, category}. Верни только JSON."

VLM-ответ валидируется Zod-схемой. При успехе — auto-создаётся тикет:
«селекторы устарели, VLM-fallback сработал».

---

## 7. Data model (PostgreSQL через Prisma)

```
Competitor (1) ─┬─ (N) Service
                 │       │
                 │       └─ (N) PriceSnapshot  ← time-series
                 │
                 ├─ (N) ScrapeRun              ← лог запусков
                 │       │
                 │       └─ (N) ScrapeAlert
                 │
                 └─ (N) ScrapeSpec             ← версии spec-схем
```

Ключевые поля:

```prisma
// Справочник регионов (см. раздел 0.3)
model Region {
  id          String   @id   // "moscow" | "mo" | "spb" | ...
  name        String         // "Москва" | "Московская область" | ...
  isDefault   Boolean  @default(false)  // только одна строка может быть true
  createdAt   DateTime @default(now())
}

// Конфиг приложения (одна строка, обновляется при смене scope)
model AppConfig {
  id            Int      @id @default(1)
  targetRegion  String   // FK → Region.id (см. раздел 0.3)
  region        Region   @relation(fields: [targetRegion], references: [id])
  updatedAt     DateTime @updatedAt
}

model PriceSnapshot {
  id            Int      @id @default(autoincrement())
  serviceId     Int
  service       Service  @relation(fields: [serviceId], references: [id])
  price         Decimal  @db.Decimal(10, 2)
  pricePrevious Decimal? @db.Decimal(10, 2)
  deltaPct      Decimal? @db.Decimal(6, 2)
  currency      String   @default("RUB")
  // === scope-поля (см. раздел 0.4.2) ===
  region        String   @default("moscow")  // FK → Region.id
  locationKey   String?  // детализация внутри региона (клиника/тариф/категория)
  isMinPrice    Boolean  @default(false)     // true если цена "от X" (Medsi, Altamed+ stom)
  // ===
  scrapedAt     DateTime @default(now())
  scrapeRunId   Int
  rawHtmlS3Key  String?  // ссылка на raw lake

  @@index([serviceId, region, scrapedAt])
  @@index([region, scrapedAt])
  @@index([scrapedAt])
  // Уникальность: одна цена на (service, region, locationKey) в рамках scrape-run
  @@unique([serviceId, region, locationKey, scrapeRunId])
}
```

**Контракт scope на уровне БД:**
- `region` — обязательное поле, NOT NULL. Default берётся из `AppConfig.targetRegion`.
- `locationKey` — nullable, для детализации внутри региона.
- `isMinPrice` — флаг для цен формата «от X» (Medsi SEO-блок, Altamed+ stom «от 6500 ₽»).
- Уникальный индекс `[serviceId, region, locationKey, scrapeRunId]` — не даёт
  создать дубль в одном сборе.
- Составной индекс `[serviceId, region, scrapedAt]` — для time-series запросов
  по конкретной услуге в конкретном регионе.

`price` в `Decimal` — не `Float`. Деньги в float — грех.

---

## 8. Observability

### 8.1. Метрики (Prometheus)

| Метрика | Тип | Зачем |
|---|---|---|
| `scrape_runs_total{competitor,status}` | counter | success rate |
| `scrape_duration_seconds{competitor,tier}` | histogram | latency p50/p95/p99 |
| `scrape_items_extracted{competitor}` | histogram | объём данных |
| `scrape_price_changes{competitor}` | counter | активность изменений |
| `scrape_blocks_total{competitor,reason}` | counter | 403/429/captcha |
| `scrape_fallback_used{competitor,from_tier,to_tier}` | counter | деградация стратегий |
| `scrape_raw_bytes{competitor}` | counter | трафик |
| `queue_depth{queue}` | gauge | backlog |

### 8.2. Логи (pino, structured JSON)

Каждый лог содержит `traceId`, `competitor`, `scrapeRunId`. Уровни:
- `info`: запуск, завершение, кол-во items
- `warn`: fallback сработал, retry, soft-validation fail
- `error`: hard fail, block, network error
- `debug`: детали парсинга (только в dev)

### 8.3. Tracing (OpenTelemetry)

Один trace на scrape-run. Span'ы:
- `scheduler.dispatch`
- `queue.wait`
- `fetch.http` (с URL, status, duration)
- `parse.html` (с tier, items extracted)
- `normalize.llm` (если вызывался)
- `validate.zod`
- `store.upsert` (с rows_affected)
- `alert.dispatch` (если был)

### 8.4. Alerting

| Триггер | Канал | Severity |
|---|---|---|
| Scrape run failed | Telegram | warning |
| items_extracted < minItems 3 раза подряд | Telegram | warning |
| Hard block (403/429) | Telegram + email | critical |
| Цена изменилась >30% | Telegram | info |
| Fallback T1→T8 (VLM) сработал | Telegram + GitHub Issue | warning |
| Queue depth > 100 | Telegram | warning |
| Scraper worker OOM/restart | Sentry + PagerDuty | critical |

---

## 9. DevOps & deployment

### 9.1. Контейнеризация

```dockerfile
# Dockerfile.scraper
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/lib/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER node
CMD ["node", "dist/worker.js"]
```

Chromium ставится системно, не через `npx playwright install` —
меньше образ, стабильнее в проде.

### 9.2. Compose-окружение (dev)

```yaml
# docker-compose.yml
services:
  app:        { build: ., ports: ["3000:3000"], env_file: .env }
  worker:     { build: ., command: node dist/worker.js, env_file: .env }
  postgres:   { image: postgres:16, volumes: [pgdata:/var/lib/postgresql/data] }
  redis:      { image: redis:7-alpine }
  minio:      { image: minio/minio, command: server /data, ports: ["9000:9000"] }
  loki:       { image: grafana/loki }
  prometheus: { image: prom/prometheus }
  grafana:    { image: grafana/grafana }
volumes: { pgdata: {} }
```

### 9.3. Health & readiness

- `/healthz` — процесс жив
- `/readyz` — Redis/Postgres/MinIO доступны, spec-схемы загружены
- K8s livenessProbe: `/healthz`, readinessProbe: `/readyz`

### 9.4. Secrets

- `.env` в dev
- Docker secrets / K8s secrets в проде
- Никогда не коммитим прокси-креды, API-ключи 2Captcha, токены Telegram-бота

### 9.5. CI/CD

```
on push:
  - lint (eslint, tsc --noEmit)
  - test (unit + парсер-фикстуры из raw-lake)
  - build (docker image)
  - deploy (на merge в main: rolling update)
```

Парсер-тесты запускаются на **реальных исторических HTML** из raw-lake,
а не на синтетике. Это ловит регрессии при изменении парсера.

---

## 10. Юридические и этические рамки (РФ)

1. **152-ФЗ** не покрывает публичные цены — они не ПДн
2. **St. 1225-ФЗ «О коммерческой тайне»** — публичные цены не КТ
3. **`robots.txt`** — соблюдать, даже если юридически не обязывает
4. **ToS сайта** — читать, особенно пункты про автоматизацию. Если прямо запрещён scraping — запрашивать данные официально
5. **Не обходить капчу агрессивно** — это уже grey zone
6. **Rate limit** — не больше, чем нужно. 1 запрос/2сек — норма
7. **Не хранить персональные данные** пациентов/врачей, если случайно попали в HTML
8. **Не публиковать** собранный прайс конкурентов публично — только внутреннее использование
9. **При request от конкурента удалить его данные** — предусмотреть в ToS нашего сервиса

---

## 11. Cost model (ориентировочно, с учётом scope — 1 регион)

При scope = 1 регион (см. раздел 0) объём данных минимален, поэтому cost model
существенно проще. Нагрузка на трафик: ~50 МБ за полный сбор вместо ~1 ГБ.

| Компонент | 5 конкурентов, ежедневный сбор, 1 регион | Стоимость/мес |
|---|---|---|
| VPS 2CPU/4GB в РФ (Москва) (scraper + worker) | 1 шт | ~2000₽ |
| PostgreSQL self-hosted на VPS (small) | включено | 0 |
| Redis self-hosted на VPS | включено | 0 |
| MinIO self-hosted (50GB достаточно) | включено | 0 |
| **Helix-Москва: residential proxy** (5-10 ГБ/мес) | обязательно для Helix | ~1500-2500₽ |
| 2Captcha | не нужен (T1-T3 без антибота) | 0 |
| VLM z-ai | только для fallback (редко) | ~0-300₽ |
| Grafana Cloud free tier | метрики | 0 |
| Sentry developer | ошибки | 0 |
| **Итого MVP (5 конкурентов, 1 регион)** | | **~3500-4500₽/мес** |

**Сравнение с вариантом без scope:**
- Без scope (5 конкурентов × все города РФ): ~15000-25000₽/мес (трафик + прокси + БД)
- Со scope (1 регион): ~3500-4500₽/мес — **в 4-5 раз дешевле**

При расширении до 10 конкурентов (если такие найдутся):
- +1 VPS при росте нагрузки: +2000₽
- +proxy на каждого конкурента с antibot: +1500₽/конкурент
- **Прогноз на 10 конкурентов, 1 регион: ~8000-12000₽/мес**

---

## 12. Roadmap реализации

### Phase 0 — Foundation & Scope (1 день)
- **Зафиксировать `TARGET_REGION`** в `.env` (см. раздел 0.3) — без этого не стартовать
- Prisma schema: `Region`, `AppConfig`, `Competitor`, `Service`, `PriceSnapshot`
  (с полями `region`, `locationKey`, `isMinPrice`), `ScrapeRun`
- Config loader для spec-схем (YAML) с поддержкой `region_strategy`
- Base Fetcher / Parser / Normalizer / Validator interfaces
  (с обязательным `region: Region` параметром в FetcherOptions)
- Health endpoint, structured logging (pino)
- **Scope validation:** в Validator — проверка `snap.region === config.targetRegion`

### Phase 1 — T1 static scraper (1-2 дня)
- Spec для Veramed (готов на 90% после разведки; `region_strategy: tariff_select`)
- Spec для Gemotest (готов на 80%; `region_strategy: url_prefix`, mapping `mo→moskva`)
- Static HTML fetcher (undici + retry + proxy опц.)
- Cheerio parser с multi-selector fallback
- Diff logic для price snapshots (учёт `region` + `locationKey`)
- First scrape → 3 261 + 3 300 услуг для целевого региона в БД

### Phase 2 — T2 JSON-extract (1 день)
- Spec для Helix (`region_strategy: ip_default`)
- JSON-extract стратегия (regex `"G.json./api/...": {"body": {...}}`)
- Zod-валидация JSON-ответа
- Pagination handler (90 страниц)
- **Helix-Москва:** либо московский прокси (если бюджет есть), либо пометить как
  `region: spb` явно с комментарием в AppConfig

### Phase 3 — Dashboard (1-2 дня)
- Список конкурентов с KPI (с фильтром по `region`)
- Графики динамики цен (Recharts/ECharts) — с разбивкой по `locationKey`
- Таблица услуг с фильтрами (region, locationKey, isMinPrice)
- Детали scrape-run (лог, raw html ссылка)
- **Индикатор scope** в шапке: «Текущий регион: Московская область»
  (напоминает пользователю о scope-ограничении)

### Phase 4 — Scheduler & alerts (1 день)
- BullMQ worker
- Cron-spec в YAML (с учётом scope — разные конкуренты могут собираться с разной частотой)
- Telegram-бот для алертов (в сообщении явно указывается `region`)
- Diff-notifier: «цена на X (регион: MO) изменилась на Y%»

### Phase 5 — VLM fallback (1 день)
- T8 стратегия
- Screenshot helper (playwright)
- z-ai VLM SDK интеграция
- Auto-issue creation при срабатывании

### Phase 6 — Hardening (1-2 дня)
- LLM-нормализатор названий
- Raw-lake (MinIO)
- OpenTelemetry tracing
- Prometheus metrics
- Тесты на исторических фикстурах

### Phase 7 — Production-ready
- Docker compose / K8s manifests
- CI/CD pipeline
- Runbook для инцидентов
- Backup strategy для Postgres

---

## 13. Anti-patterns (чего НЕ делать)

1. **Hardcoded селекторы в коде** — должны быть в spec-файлах
2. **Float для денег** — только Decimal
3. **Sync sleep в hot path** — только Promise-based delay
4. **Один try-catch на весь pipeline** — per-stage error handling
5. **Логи без traceId** — невозможно отследить цепочку
6. **Puppeteer вместо Playwright** — Playwright стабильнее, лучше API
7. **Без raw-lake** — теряем возможность пере-парсинга
8. **Retry без exponential backoff** — гарантированно получим ban
9. **Без robots.txt проверки** — этика + иногда банят по этому признаку
10. **Selenium** — устарел, медленный, нестабильный. Никогда
11. **BeautifulSoup на Python** — если весь проект на TS, не тащить второй язык
12. **Scrapy (Python)** — отличный фреймворк, но не在我们的 stack'е
13. **Прямые запросы к DB из парсера** — только через репозиторий
14. **Magic numbers** — все лимиты/timeout'ы в конфиге

---

## 14. Open questions (для уточнения с заказчиком)

### Решённые (после обсуждения scope — см. раздел 0)

- ✅ **Мультигородность:** НЕ нужна. Сбор только в одном целевом регионе (Москва
  или МО). См. раздел 0.1.
- ✅ **Хостинг:** VPS в РФ обязателен — иначе Helix/Medsi получают нерелевантный
  регион по IP. Москва-сервер → Москва-цены для Helix/Medsi.
- ✅ **Полная тарифная сетка Medsi (63 клиники Москвы):** НЕ собирается. Только
  min-цены из SEO-блока (соответствует robots.txt). См. раздел 0.4.4.

### Открытые

1. Сколько всего конкурентов планируется? (от этого зависит: 1 worker или кластер)
2. **Целевой регион = `moscow` или `mo`?** Это нужно зафиксировать на старте
   (`TARGET_REGION`). Смешивать в MVP нельзя. Рекомендация: начать с `mo`, т.к.
   Veramed и Altamed+ уже локализованы в МО, а Gemotest/Helix/Medsi одинаково
   хорошо работают с любым городом.
3. Нужны ли исторические графики за >1 года? (TimescaleDB)
4. Экспорт в Excel/Google Sheets — one-shot или по расписанию?
5. Авторизация в системе — один пользователь или команда с ролями?
6. Сопоставление с собственным прайсом — нужен справочник услуг?
7. **Helix-Москва:** требуется московский IP-прокси (~3000₽/мес за residential).
   Альтернатива: собирать СПб-цены и пометить как «по умолчанию». Решить.
8. Бюджет на residential proxy — нужен ли вообще? (только для Helix-MSK)

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

**Итого со scope:** ~2 785 страниц, ~9 875 позиций, ~1 ГБ трафика за полный сбор.
Без scope было бы: ~80 000+ позиций, многократно больше трафика.

**Важное замечание по Helix:** из РФ-сервера SSR определяет город по IP — мы
видим СПб. Для сбора **Москвы** потребуется российский прокси-сервер с
московским IP. Это оформлено в open-questions (см. раздел 14.7).

## Приложение B. Селекторы / паттерны (выжимка)

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

**Архитектурная особенность:** единого прайса нет. Цены распределены по ~294
индивидуальным страницам услуг. 31% страниц не имеют прайса вообще (информационные).

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
Цена: "3 000" (пробел-разделитель), валюта: `<span>руб.</span>`

Format 2 — `table_min` (стоматология, ~20% страниц):
```regex
<tr>\s*<td[^>]*>\s*(.+?)\s*</td>\s*<td[^>]*>\s*((?:от\s+)?[\d\s\u00A0]+₽)\s*</td>\s*</tr>
```
Особенности:
- Заголовки секций через `<tr><td colspan="2">SECTION_TITLE</td></tr>` — нужно пропускать
- Цена: "1 200 ₽" или "от 6 500 ₽" (префикс "от" = минимальная цена)
- Разделитель тысяч: пробел ИЛИ `&nbsp;` — нормализовать оба

**Дедупликация:** `(normalized_name)` — та же услуга встречается на vector-странице
и на cure-подстранице. Пример: "Регистрация электрокардиограммы" есть и на
`/services/vectors/kardiologiya/` (700 руб.), и на
`/services/cure/elektrokardiogramma-ekg/` (700 руб.) — та же цена.

**Уникальный ключ:** нет stable ID. Использовать `normalize(name)` (lowercase,
trim, удалить лишние пробелы). При конфликте цен — брать с страницы более
специфичной (cure > vector).

**Validation rules (spec-specific):**
- `min_items_total: 500` (после дедупа)
- `pages_with_prices_ratio: 0.6-0.8` (ожидается 60-80% страниц имеют прайс)
- `price_range: [100, 500000]` ₽
- `allow_zero_items_per_page: true` (31% страниц информационные)
- `alert_if_pages_with_prices_drops_below: 120` (из 243 cure-страниц)

**Spec-схема (концепт):**
```yaml
competitor: altamed
base_url: https://www.altamedplus.ru
tier: T1
strategy: distributed_static_html
discovery:
  type: bfs_crawl
  seeds:
    - /services/
    - /services/vectors/
    - /services/cure/
    - /services/analysis_and_diagnostics/
  link_pattern: '/services/(vectors|cure|analysis_and_diagnostics|cosmetology|stomatology)/[^"#+]/$'
  max_depth: 3
  expected_pages: 294
parsers:
  - name: table_price
    selector: 'table.table-price'
    item_pattern: '<tr>\s*<td>\s*(.+?)\s*</td>\s*<td>\s*<div class="price">\s*(.+?)\s*<span>руб\.</span>'
    fields:
      name: { group: 1, post: strip_tags_normalize }
      price: { group: 2, transform: parse_rub_space }
  - name: table_min
    selector: 'table.table_min'
    item_pattern: '<tr>\s*<td[^>]*>\s*(.+?)\s*</td>\s*<td[^>]*>\s*((?:от\s+)?[\d\s\u00A0]+₽)\s*</td>'
    skip_rows_with: 'colspan'
    fields:
      name: { group: 1, post: strip_tags_normalize }
      price_raw: { group: 2 }
      price: { from: price_raw, transform: parse_rub_unicode }
      is_min_price: { from: price_raw, transform: 'value.startsWith("от")' }
deduplication:
  key: normalize(name)
  priority: cure > vector > other  # cure-страница приоритетнее
schedule: "0 4 * * 1"  # понедельник 04:00 ( реже, т.к. больше страниц)
```

---

### Medsi (Hybrid T1 + T3)

**Архитектурная особенность:** сайт разделён на 2 независимых каталога с разными
технологиями:

1. **`/services/**`** — Битрикс + Vue SSR-фрагменты. 1 248 страниц услуг.
   Цены доступны **двумя способами**:
   - **T1 path (curl, plain HTML):** SEO-блок `<p class="hdn">Прием специалиста: NAME - от PRICE руб.; ...</p>`
     — содержит **минимальные** цены по всем клиникам, без разбивки.
   - **T2 path (page_reader / Playwright):** Vue-rendered `med-service-block__type-item-price-num-inner`
     — конкретные цены для одной клиники (определяется IP/cookie).

2. **`/labmarket/**`** — SPA на Vue, 1 086 анализов SmartLab. Полный список URL
   доступен в sitemap, но цены **только после JS-execution**.

**Критическое ограничение robots.txt:**
```
Disallow: /*clinic=       ← Запрещён параметр привязки к клинике
Disallow: /*?             ← Запрещены ВСЕ query-параметры
```
**Этическое решение:** собираем только SEO-блок (минимальные цены) с `/services/`
без `?clinic=`. Это полностью соответствует robots.txt и даёт 1 250 услуг с
минимальными ценами по Москве.

**Sitemap (полный и достоверный):**
- `https://medsi.ru/sitemap.xml` → index
- `https://medsi.ru/sitemaps/sitemap-0.xml` → 5 001 URL
- `https://medsi.ru/sitemaps/sitemap-1.xml` → 4 738 URL
- Категории: 1 248 services + 677 clinics + 1 094 labmarket + 1 975 doctors + 1 033 articles

**Discovery:** не нужен — sitemap полный. Просто фильтруем URLs по паттерну.

**Парсеры:**

Parser 1 — SEO block на `/services/{slug}/` (T1, plain HTML):
```regex
context:  <p class="hdn">(Прием специалиста:|Услуги:|Описание услуг:)\s*(.+?)</p>
item:     ([^.]+?)\s*-\s*(?:от\s+)?(\d[\d\s]*)\s*руб\.
```
Поля: `name`, `price_min` (с пометкой `is_min_price: true`, т.к. цены "от X руб.")
Валюта: `руб.` (словом, не ₽)

Parser 2 — Vue-rendered prices (T2, page_reader):
```regex
context:  med-service-block__type-item--service
name:     med-service-block__type-item-name _service-name[^"]*">\s*([^<]+?)\s*</div>
price:    price-num-inner[^>]*>\s*(?:<!---->)?\s*<span[^>]*>(.+?)<span class="rub">руб\.</span>
clinic:   med-service-block__type-item-name--clinic[^"]*">\s*([^<]+?)\s*</div>
street:   med-service-block__type-item-street[^"]*">\s*([^<]+?)\s*</div>
```
Особенности:
- `&nbsp;` как HTML-entity (6 символов), НЕ unicode `\u00A0` — нужна декодировка
- `data-v-{hash}` атрибуты от Vue SSR — игнорировать
- Цена = конкретная для клиники (не "от")
- Привязка к clinic: `clinic` + `street` в detail-info блоке

Parser 3 — Labmarket SPA (T3, требует JS-execution):
```regex
context:  class="slider-item-wrapper"  или  class="one_of_test"
name:     href="(/labmarket/service/[^"]+)"\s+class="p_test_name"[^>]*>\s*([^<]+?)\s*</a>
price:    <span class="lb-test__price-btn-mod">от</span>\s*<span>\s*(\d[\d\s]*)\s*<span[^>]*>\s*₽
```
Структура на главной (60 популярных тестов):
- `<a class="p_test_name" href="/labmarket/service/{slug}/">NAME</a>`
- `<span class="lb-test__price-btn-mod">от</span> <span>1500 <span>₽</span>`

Индивидуальная страница `/labmarket/service/{slug}/`:
- `<div class="total-info_price">Цена: от 270 ₽*</div>` — цена
- `<div class="total-info_deadline_text">Срок исполнения: 1 календарный день...</div>` — срок

**Два уровня цен для услуг `/services/`:**
- **Min-цена** (по всем клиникам): доступна легально через SEO-блок
- **Конкретная цена по клинике**: требует `?clinic={slug}` — **запрещено robots.txt**

**Уникальный ключ:**
- services: `normalize(name)` — нет stable ID
- labmarket: `slug` из URL (`/labmarket/service/{slug}/`) — стабильно

**Validation rules:**
- `min_items_services: 800` (из 1 248 страниц ~65% имеют SEO-блок)
- `min_items_labmarket: 1000` (из 1 086 service-страниц)
- `price_range: [50, 500000]` ₽
- `alert_if_seo_block_missing_on: 50%` страниц (если SEO-блок пропал >50% — редизайн)

**Нагрузка:**
- `/services/` страницы: ~400 КБ × 1 248 = ~488 МБ (curl, без JS)
- `/labmarket/service/` страницы: ~360 КБ × 1 086 = ~382 МБ (page_reader с JS)
- `/clinics/`: ~300 КБ × 677 = ~198 МБ (опционально, для метаданных клиник)
- **Итого: ~1 ГБ**, ~3 011 страниц
- Sequential (1 req/2s): ~100 минут
- Parallel (10 threads): ~10 минут

**Spec-схема (концепт):**
```yaml
competitor: medsi
base_url: https://medsi.ru
tier: hybrid
strategies:
  services:
    strategy: static_html_with_seo_block
    discovery: sitemap
    sitemap_urls:
      - https://medsi.ru/sitemaps/sitemap-0.xml
      - https://medsi.ru/sitemaps/sitemap-1.xml
    url_filter: '/services/[^/]+/$'  # только leaf, без /section-*/
    parser:
      type: seo_block_regex
      context: '<p class="hdn">(Прием специалиста:|Услуги:|Описание услуг:)\s*(.+?)</p>'
      item: '([^.]+?)\s*-\s*(?:от\s+)?(\d[\d\s]*)\s*руб\.'
      fields:
        name: { group: 1, post: strip_normalize }
        price_min: { group: 2, transform: parse_int }
        is_min_price: true
    robots_compliance:
      disallow: ['?clinic=', '?*']
      note: 'Собираем только минимальные цены из SEO-блока'

  labmarket:
    strategy: spa_js_rendered
    fetcher: page_reader  # z-ai SDK с JS-execution
    discovery: sitemap
    url_filter: '/labmarket/service/[^/]+/$'
    parser:
      type: html_regex
      context: 'total-info_price'
      item: 'Цена:\s*от\s*(\d[\d\s]*)\s*₽'
      fields:
        price_min: { group: 1, transform: parse_int }
        is_min_price: true
      extra:
        deadline: '<div class="total-info_deadline_text">\s*Срок исполнения:\s*([^<]+)</div>'
    expected_pages: 1086
    schedule: "0 5 * * *"  # ежедневно в 05:00
    note: 'Цены "от" — минимальные по клиникам сети'
```

**Открытые вопросы по Medsi (после фиксации scope — см. раздел 0):**

1. ~~Достаточно ли минимальных цен?~~ → **РЕШЕНО:** да, в рамках scope (1 регион).
   Сбор конкретных цен по 63 клиникам Москвы запрещён robots.txt. Если
   потребуется — это юридический вопрос, не технический.
2. Labmarket (SmartLab) — отдельный бренд анализов. Включать ли в сравнение с
   клиниками? (Прямые конкуренты Gemotest/Helix, но не Veramed/Altamed)
3. Срок исполнения есть только на labmarket. На /services/ — нет. ОК?

---

*Документ обновляется по мере разбора новых конкурентов и реализации фаз.
Scope сбора зафиксирован в разделе 0 — изменение требует миграции БД.*
