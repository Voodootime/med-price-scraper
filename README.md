# MedPrice Tracker — Универсальный скрапер медицинских прайсов

> Универсальный движок для автоматического сбора цен и услуг с медицинских сайтов.
> Движок сам определяет тип сайта, выбирает оптимальную стратегию сбора,
> генерирует spec-схему и самовосстанавливается при изменении вёрстки.

## 📖 Документация

- **[docs/scraping-methodology.md](docs/scraping-methodology.md)** — полная методология
  (1600 строк): классификация тиров, Probe Engine, Discovery Engine, Schema inference,
  Adaptive parser, Universal data model, AI Skills, Roadmap, эталонные кейсы
  (Veramed, Gemotest, Helix, Altamed+, Medsi, CMD).
- **[worklog.md](worklog.md)** — журнал разработки мультиагентной команды.

## 🚀 Быстрый старт

```bash
# Установка зависимостей
bun install

# Инициализация БД
bun run db:push
bun run db:seed

# Запуск dev сервера
bun run dev
# → http://localhost:3000
```

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

```env
DATABASE_URL=file:./db/custom.db
TARGET_REGION=mo              # moscow | mo | spb
LOG_LEVEL=info
DEFAULT_RATE_LIMIT_MS=2000
DEFAULT_CONCURRENCY=5
VLM_DAILY_QUOTA=100
LLM_DAILY_QUOTA=1000
```

## 📈 Roadmap

- ✅ **Phase 0:** Foundation (Prisma schema, interfaces, logger, config, dashboard)
- 🔄 **Phase 1:** Probe Engine (автоопределение характеристик сайта)
- ⬜ **Phase 2:** Discovery Engine (поиск URL с ценами)
- ⬜ **Phase 3:** Parsers (Schema.org, cheerio, JSON-extract, SPA)
- ⬜ **Phase 4:** Schema Inference (heuristic + LLM)
- ⬜ **Phase 5:** Normalizer (LLM canonicalization)
- ⬜ **Phase 6:** Dashboard (полнофункциональный)
- ⬜ **Phase 7:** Scheduler & alerts (BullMQ, Telegram)
- ⬜ **Phase 8:** Self-healing
- ⬜ **Phase 9:** VLM fallback
- ⬜ **Phase 10:** Hardening (raw-lake, OTel, regression tests)
