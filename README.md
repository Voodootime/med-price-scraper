# MedPrice Tracker — Универсальный скрапер медицинских прайсов

> Универсальный движок для автоматического сбора цен и услуг с медицинских сайтов.
> Движок сам определяет тип сайта, выбирает оптимальную стратегию сбора,
> генерирует spec-схему и самовосстанавливается при изменении вёрстки.

## 📖 Документация

- **[docs/scraping-methodology.md](docs/scraping-methodology.md)** — полная методология
  (1847 строк): классификация тиров, Probe Engine, Discovery Engine, Schema inference,
  Adaptive parser, Universal data model, AI Skills, Roadmap, эталонные кейсы
  (Veramed, Gemotest, Helix, Altamed+, Medsi, CMD).
- **[docs/product-roadmap.md](docs/product-roadmap.md)** — актуальный продуктовый roadmap
  с приоритетами P0-P6 и ближайшими Definition of Done.
- **[docs/development-roadmap-detailed.md](docs/development-roadmap-detailed.md)** — детальный
  план этапов разработки, критерии готовности, риски и ближайшие инженерные задачи.
- **[docs/competitors-collection-logic.md](docs/competitors-collection-logic.md)** — полная
  логика работы со всеми конкурентами: архитектура, методы сбора, parser strategies,
  region handling, validation rules, fixture requirements per competitor.
- **[docs/testing-guide.md](docs/testing-guide.md)** — полный сценарий тестирования:
  от клонирования до проверки боевого scrape-run на CMD Online.
- **[worklog.md](worklog.md)** — журнал разработки мультиагентной команды.

## 🚀 Быстрый старт

```bash
# Установка зависимостей
bun install

# Создание .env из шаблона (минимум DATABASE_URL обязателен)
cp .env.example .env
# отредактируй .env: укажи TARGET_REGION и при необходимости ZAI_API_KEY

# Инициализация БД (Prisma + SQLite)
bun run db:push
bun run db:seed

# Запуск dev сервера
bun run dev
# → http://localhost:3000
```

Полный список env-переменных и их значения по умолчанию —
в [`src/lib/config/index.ts`](src/lib/config/index.ts) (zod-схема) и в [`.env.example`](.env.example).

## 🏗️ Архитектура

```
src/
├── app/                    # Next.js App Router
│   ├── api/               # API endpoints
│   │   ├── health/        # Health check (DB, config, region)
│   │   ├── competitors/   # CRUD конкурентов
│   │   └── download/      # Скачивание проекта/документации
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Dashboard
├── components/
│   ├── ui/                # shadcn/ui (полный набор)
│   ├── dashboard/         # Компоненты дашборда
│   └── providers.tsx      # React Query + Sonner
├── lib/
│   ├── db.ts              # Prisma client
│   ├── config/            # Zod-валидация env
│   ├── logger/            # Pino логгер
│   └── seed.ts            # Seed регионов и AppConfig
├── scraper/               # Универсальный скрапер
│   ├── types/             # Tier, RegionStrategy, ProbeResult, UniversalPriceItem
│   ├── interfaces/        # Fetcher, Parser, Normalizer, Validator, ProbeEngine
│   ├── strategies/        # Реализации стратегий (Phase 1+)
│   └── utils/             # parsePrice, formatPrice, sha256, etc.
└── hooks/                 # React hooks
```

## 📊 Стек

- **Framework:** Next.js 16 (App Router, Turbopack)
- **Language:** TypeScript 5 (strict)
- **Styling:** Tailwind CSS 4 + shadcn/ui (New York)
- **Database:** Prisma 6 + SQLite
- **Validation:** Zod 4
- **State:** TanStack Query 5
- **AI SDK:** z-ai-web-dev-sdk (VLM, LLM, Web-Reader, Web-Search)
- **Scraping:** cheerio, linkedom, robots-parser, yaml
- **Logging:** pino

## 🎯 Scope сбора

Система собирает цены **только в одном регионе** (Москва или МО).
Полная федеральная тарифная сетка не собирается. См. раздел 0 методологии.

## ⚙️ Конфигурация (.env)

Минимальный набор для запуска:

```env
DATABASE_URL=file:./db/custom.db
TARGET_REGION=mo              # moscow | mo | spb
LOG_LEVEL=info
```

Полный список переменных: см. [`.env.example`](.env.example).
Валидация — через zod-схему в [`src/lib/config/index.ts`](src/lib/config/index.ts) (fail-fast при ошибке).

| Категория | Переменные |
|---|---|
| Core | `NODE_ENV`, `DATABASE_URL`, `PORT` |
| Scope | `TARGET_REGION` |
| Logging | `LOG_LEVEL` |
| Rate limits | `DEFAULT_RATE_LIMIT_MS`, `DEFAULT_CONCURRENCY`, `MAX_RETRIES` |
| AI quotas | `VLM_DAILY_QUOTA`, `LLM_DAILY_QUOTA`, `WEB_READER_DAILY_QUOTA`, `WEB_SEARCH_DAILY_QUOTA` |
| z-ai SDK | `ZAI_API_KEY` |
| API protection | `ADMIN_API_KEY` |
| Storage | `RAW_LAKE_PATH`, `SCREENSHOTS_PATH` |
| Proxy | `PROXY_URL`, `PROXY_USER`, `PROXY_PASS` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

## 📈 Roadmap

- ✅ **Phase 0:** Foundation (Prisma schema, interfaces, logger, config, dashboard)
- ✅ **Phase 1:** Probe Engine (автоопределение характеристик сайта — `POST /api/probe`)
- ⬜ **Phase 2:** Discovery Engine (поиск URL с ценами)
- ⬜ **Phase 3:** Parsers (Schema.org, cheerio, JSON-extract, SPA)
- ⬜ **Phase 4:** Schema Inference (heuristic + LLM)
- ⬜ **Phase 5:** Normalizer (LLM canonicalization)
- ⬜ **Phase 6:** Dashboard (полнофункциональный)
- ⬜ **Phase 7:** Scheduler & alerts (BullMQ, Telegram)
- ⬜ **Phase 8:** Self-healing
- ⬜ **Phase 9:** VLM fallback
- ⬜ **Phase 10:** Hardening (raw-lake, OTel, regression tests)

Статус разработки по фазам и задачи мультиагентной команды — в [`worklog.md`](worklog.md).
