# Методология скрапинга прейскурантов медицинских услуг

> Документ-конспект уровня senior fullstack + devops. Описывает классификацию
> целей, выбор стека, архитектуру конвейера, антидетект, observability и
> операционные практики. Является основой для реализации парсер-движка в проекте.

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
model PriceSnapshot {
  id            Int      @id @default(autoincrement())
  serviceId     Int
  service       Service  @relation(fields: [serviceId], references: [id])
  price         Decimal  @db.Decimal(10, 2)
  pricePrevious Decimal? @db.Decimal(10, 2)
  deltaPct      Decimal? @db.Decimal(6, 2)
  currency      String   @default("RUB")
  city          String?
  tariff        String?
  scrapedAt     DateTime @default(now())
  scrapeRunId   Int
  rawHtmlS3Key  String?  // ссылка на raw lake

  @@index([serviceId, scrapedAt])
  @@index([scrapedAt])
}
```

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

## 11. Cost model (ориентировочно)

| Компонент | При 10 конкурентах, ежедневный сбор | Стоимость/мес |
|---|---|---|
| VPS 4CPU/8GB (scraper + worker) | 1 шт | ~3000₽ |
| PostgreSQL managed | small | ~1500₽ |
| Redis managed | small | ~1000₽ |
| MinIO self-hosted (500GB) | включено в VPS | 0 |
| Residential proxy (50GB) | на T6-T7, опционально | ~7500₽ |
| 2Captcha (1000 solves) | опционально | ~150₽ |
| VLM z-ai (1000 запросов) | на T8 fallback | по тарифу SDK |
| Grafana Cloud free tier | метрики | 0 |
| Sentry developer | ошибки | 0 |
| **Итого MVP (T1-T2, без прокси)** | | **~5500₽/мес** |
| **Итого с T6-T7 (антибот)** | | **~13000₽/мес** |

---

## 12. Roadmap реализации

### Phase 0 — Foundation (1 день)
- Prisma schema: Competitor, Service, PriceSnapshot, ScrapeRun
- Config loader для spec-схем (YAML)
- Base Fetcher / Parser / Normalizer / Validator interfaces
- Health endpoint, structured logging (pino)

### Phase 1 — T1 static scraper (1-2 дня)
- Spec для Veramed (готов на 90% после разведки)
- Spec для Gemotest (готов на 80%)
- Static HTML fetcher (undici + retry + proxy опц.)
- Cheerio parser с multi-selector fallback
- Diff logic для price snapshots
- First scrape → 3261 + 3300 + 1078 услуг в БД

### Phase 2 — T2 JSON-extract (1 день)
- Spec для Helix
- JSON-extract стратегия (regex `"G.json./api/...": {"body": {...}}`)
- Zod-валидация JSON-ответа
- Pagination handler (90 страниц)

### Phase 3 — Dashboard (1-2 дня)
- Список конкурентов с KPI
- Графики динамики цен (Recharts/ECharts)
- Таблица услуг с фильтрами
- Детали scrape-run (лог, raw html ссылка)

### Phase 4 — Scheduler & alerts (1 день)
- BullMQ worker
- Cron-spec в YAML
- Telegram-бот для алертов
- Diff-notifier: «цена на X изменилась на Y%»

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

1. Сколько всего конкурентов планируется? (от этого зависит: 1 worker или кластер)
2. Нужна ли мультигородность для Helix? (потребуются прокси)
3. Нужны ли исторические графики за >1 года? (TimescaleDB)
4. Экспорт в Excel/Google Sheets — one-shot или по расписанию?
5. Авторизация в системе — один пользователь или команда с ролями?
6. Сопоставление с собственным прайсом — нужен справочник услуг?
7. Где хостить — VPS в РФ (тогда Helix-MSK работает) или за рубежом?
8. Бюджет на residential proxy — нужен ли вообще?

---

## Приложение A. Карта разведанных сайтов

| Сайт | Тир | URL прайса | Кол-во услуг | Spec-готовность |
|---|---|---|---|---|
| veramed-clinic.ru | T1 | `/price/` | 3 261 (3 тарифа) | High — вёрстка стабильная, классы явные |
| gemotest.ru | T1 | `/moskva/catalog/...` ×66 | ~3 300 | High — data-eec-* атрибуты, slug с "ё" осторожно |
| helix.ru | T2 | `/catalog/190-vse-analizy?page=N` ×90 | 1 078 | High — embedded JSON `G.json./api/...`, total=1078 |

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

---

*Документ обновляется по мере разбора новых конкурентов и реализации фаз.*
