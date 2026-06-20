# Worklog — Универсальный скрапер медицинских прайсов

> Этот файл — единый журнал работы мультиагентной команды. Каждый агент перед
> началом работы читает этот файл, после выполнения задачи дописывает свой
> раздел через `---`. Не перезаписывать!

## Контекст проекта

**Цель:** построить универсальный движок для автоматического сбора цен и услуг
с любых медицинских сайтов. Движок сам определяет тип сайта (T1-T10), выбирает
оптимальную стратегию сбора, генерирует spec-схему и самовосстанавливается при
изменении вёрстки.

**Scope:** один регион (Москва или МО). Полная федеральная сетка не собирается.

**Методология:** `/home/z/my-project/docs/scraping-methodology.md` (1600 строк) —
обязательное чтение для всех агентов.

**Эталонные кейсы** (для валидации универсальности движка):
- veramed-clinic.ru — T1, tariff_select, 1 URL = весь прайс
- gemotest.ru — T1, url_prefix, data-eec-* атрибуты
- helix.ru — T2, ip_default, embedded JSON `G.json./api/`
- altamedplus.ru — T1+discovery, 2 формата таблиц, BFS-crawl
- medsi.ru — Hybrid T1+T3, SEO-блок + SPA labmarket
- cmd-online.ru — T1+Schema.org, url_path_segment, 1510 URL

---

Task ID: phase-0-foundation
Agent: lead-architect (главный)
Task: Phase 0 — Foundation & Scope (раздел 17 Roadmap методологии)

Work Log:
- Аудит текущего состояния проекта:
  - Next.js 16 + TS 5 strict + Tailwind 4 + полный shadcn/ui ✅
  - Prisma 6 + SQLite (schema — дефолтная User/Post, нужна полная замена)
  - z-ai-web-dev-sdk, zod, react-query, recharts установлены ✅
  - worklog.md отсутствовал — создан
- План Phase 0:
  1. Установить пакеты: cheerio, pino, pino-pretty, robots-parser, linkedom, yaml
  2. Переписать prisma/schema.prisma под универсальную модель (8 моделей)
  3. db:push + верификация
  4. Структура директорий: src/scraper/{types,interfaces,utils}, src/lib/{config,logger}
  5. Базовые типы: UniversalPriceItem, ProbeResult, Tier, RegionStrategy, etc.
  6. Базовые интерфейсы: Fetcher, Parser, Normalizer, Validator, DiscoveryStrategy, ProbeEngine
  7. Logger (pino) + config loader (yaml) + env validation (zod)
  8. Health endpoint /api/health + базовый dashboard layout
  9. Запуск dev сервера, lint, browser verification

Stage Summary:
- Фундамент готов к имплементации Phase 1 (Probe Engine)
- Все базовые интерфейсы и типы определены
- Prisma schema покрывает 8 сущностей универсальной модели
- Логирование и конфигурация готовы
- Dashboard каркас готов к наполнению в Phase 6

---

Task ID: phase-0-dashboard
Agent: frontend-styling-expert
Task: Phase 0 — Dashboard layout (single-page, sticky footer, shadcn/ui + react-query)

Work Log:
- Прочитан worklog.md и docs/scraping-methodology.md (разделы 0, 1, 2, 6).
- Аудит готового фонда:
  - shadcn/ui полный набор установлен ✅ (card, table, badge, dialog, alert, skeleton, sonner, etc.)
  - API endpoints: /api/health, /api/competitors (GET/POST) — рабочие ✅
  - Prisma-модели Competitor/Service/PriceSnapshot/ScrapeRun/etc. — готовы ✅
  - Типы Tier, RegionStrategyType, UniversalPriceItem в src/scraper/types/index.ts ✅
  - TARGET_REGION=mo в .env ✅
  - react-query, sonner, lucide-react установлены ✅
  - react-query Provider отсутствовал — добавлен (см. ниже)
- Создано файлов:
  1. `src/components/providers.tsx` — QueryClientProvider (singleton через useState)
     + Sonner Toaster (richColors, top-right). Default staleTime=30s, retry=1.
  2. `src/components/dashboard/shared.ts` — общие утилиты:
     - REGION_LABELS (mo → "Московская область", moscow → "Москва", spb → "Санкт-Петербург")
     - STATUS_LABELS + STATUS_BADGE_CLASSES (active=emerald, new=amber, needs_review=orange,
       blocked=red, probing/deprecated=muted — БЕЗ indigo/blue по правилам проекта)
     - TIER_LABELS_SHORT (T1..T10 — короткие подписи для таблицы)
     - formatRelativeDate / formatFullDate / shortenUrl
     - useHealth() хук (queryKey ['health'], refetchInterval 60s)
  3. `src/components/dashboard/dashboard-header.tsx` — sticky top-0 z-40 шапка:
     - Лого "MedPrice Tracker" с Activity иконкой
     - Badge с регионом (MapPin)
     - Button "Добавить конкурента" (открывает AddCompetitorDialog)
  4. `src/components/dashboard/dashboard-footer.tsx` — footer с mt-auto (sticky bottom
     по правилам проекта): версия, env, region, health-status badge, uptime,
     ссылка на /api/health. HeartPulse/Heart иконки.
  5. `src/components/dashboard/stats-cards.tsx` — 4 Card: Конкуренты (Users),
     Услуги (Database), Сборов сегодня (Activity), Alerts (Bell).
     - useCompetitors() хук (queryKey ['competitors'], refetchInterval 30s, staleTime 15s)
     - useStats() — вычисляет competitors total + Σ itemsCount из competitors list;
       scrapesToday/alerts = 0 (заглушка до /api/stats в Phase 6)
     - Loading: Skeleton; tabular-nums для выравнивания чисел
  6. `src/components/dashboard/add-competitor-dialog.tsx` — Dialog с формой:
     - Поля: name (label "Название"), baseUrl (label "Базовый URL")
     - Авто-нормализация URL (добавляет https:// если нет схемы)
     - useMutation → POST /api/competitors
     - onSuccess: toast.success + invalidate ['competitors'] + закрытие
     - 409: Alert "Конкурент с таким URL уже существует"
     - 400: Alert "Некорректные данные"
     - Кнопка submit с Loader2 spinner во время pending
  7. `src/components/dashboard/competitors-table.tsx` — Card с Table:
     - Колонки: Название, URL, Статус (Badge), Tier (Badge), Услуг, Последний сбор
     - URL: кликабельный с ExternalLink иконкой, shortenUrl()
     - Loading: 5 skeleton-rows
     - Empty state: Inbox иконка + "Нет конкурентов. Добавьте первого..."
     - Error state: Alert destructive с подсказкой проверить /api/health
     - Кнопка "Обновить" (refetch, отключена во время isFetching)
  8. `src/components/dashboard/recent-activity.tsx` — Card с timeline:
     - 5 фейковых scrape-run (CMD Online, Gemotest, Helix, Veramed, Altamed+)
       с разными статусами (success/partial/failed/running)
     - Timeline-визуал: иконка-точка слева + соединительная линия
     - Status badge + items count + duration formatted
  9. `src/app/page.tsx` — полная переработка под client component dashboard:
     - 'use client' + min-h-screen flex flex-col wrapper
     - DashboardHeader (sticky top) + main (flex-1 gap-6) + DashboardFooter (mt-auto)
     - Глобальный Alert если health.status !== 'ok' или health endpoint unavailable
     - Responsive grid: stats (1/2/4 cols) + table+activity (1 col mobile, xl:1fr+28rem)
- Изменено файлов:
  - `src/app/layout.tsx` — обёрнуто в <Providers>, обновлены metadata
    (title: "MedPrice Tracker — скрапер медицинских прайсов", lang="ru"),
    удалён старый Toaster (заменён на Sonner внутри Providers).
- Цветовая палитра: emerald (primary accent), amber (new), orange (needs_review),
  red (blocked/alerts). Indigo/blue НЕ используются — соответствует правилам проекта.
- Dark mode: все цвета через Tailwind CSS variables + dark: варианты для status badges.

Verification:
- `bun run lint` — 0 ошибок, 0 предупреждений ✅
- `bun x tsc --noEmit` — 0 ошибок в src/ (есть ошибки только в examples/ и skills/, не наших) ✅
- `curl http://localhost:3000` — HTTP 200, HTML содержит "MedPrice Tracker" ✅
- agent-browser E2E: header → "Регион: Московская область" badge + "Добавить конкурента" button ✅
- agent-browser E2E: 4 stat cards рендерятся (Конкуренты/Услуги/Сборов сегодня/Alerts) ✅
- agent-browser E2E: empty state "Нет конкурентов. Добавьте первого..." ✅
- agent-browser E2E: timeline 5 элементов с разными статусами ✅
- agent-browser E2E: клик "Добавить конкурента" → диалог открывается (Название, Базовый URL, Отмена, Добавить) ✅
- agent-browser E2E: заполнение формы + submit → toast "Конкурент добавлен" + строка в таблице с "Новый" badge ✅
- agent-browser E2E: footer показывает v0.2.0 · DEVELOPMENT · region: mo · health: ok · uptime · /api/health ✅
- POST /api/competitors → 201 (новый), 409 (дубликат URL), 400 (невалидные данные) — все кейсы обработаны ✅
- Тестовые данные удалены (Test Browser Clinic, Test Clinic) — БД чистая.

Stage Summary:
- Single-page Dashboard на `/` готов к использованию.
- Sticky header + sticky footer (mt-auto) — соответствует правилам проекта.
- React Query настроен: ['competitors'] (30s poll), ['health'] (60s poll), ['stats'] = derived.
- Все loading/empty/error states покрыты (Skeleton + Inbox + Alert).
- Форма "Добавить конкурента" работает end-to-end (mutation + invalidate + toast).
- Готов к Phase 1 — Probe Engine будет автоматически запускаться при создании конкурента
  (см. TODO в src/app/api/competitors/route.ts).

Open items (НЕ блокеры):
- /api/stats endpoint (Phase 6) — сейчас scrapesToday/alerts = 0.
- /api/scrape-runs endpoint (Phase 6) — сейчас timeline на заглушках.
- Probe trigger после POST /api/competitors (Phase 1) — см. TODO в route.ts.

---

Task ID: phase-0-verification
Agent: lead-architect (главный)
Task: Финальная верификация Phase 0 — Dashboard + API + Browser E2E

Work Log:
- Запущен dev сервер (Next.js 16 + Turbopack, порт 3000)
- Health endpoint GET /api/health → 200, status=ok, region=mo, DB latency=1ms ✅
- Competitors API GET/POST → 200/201 ✅
- Browser E2E через agent-browser:
  - Главная страница рендерится: header + 4 stat cards + empty state + timeline + footer
  - Sticky footer работает (mt-auto на footer)
  - Клик "Добавить конкурента" → диалог открывается
  - Заполнение формы (CMD Online, https://www.cmd-online.ru) → submit
  - Toast "Конкурент добавлен"
- Стат row обновился: 0 → 1
- Таблица: CMD Online | https://www.cmd-online.ru | "Новый" | "не определён" | 0 | —
- Lint: 0 ошибок, 0 предупреждений
- Browser errors: 0
- Health endpoint: status=ok, db=ok, config=ok, region=mo
- Тестовый конкурент удалён, БД чистая

## Stage Summary

Phase 0 полностью завершён и проверен end-to-end. Фундамент готов к Phase 1 (Probe Engine).

### Что готово

**Backend (8 моделей + 5 интерфейсов + 6 типов):**
- Prisma schema: Region, AppConfig, Competitor, ProbeResult, ScrapeSpec, Service, PriceSnapshot, ScrapeRun, ScrapeAlert
- Базовые типы: Tier (T1-T10), RegionStrategy (8 типов), ProbeResult, UniversalPriceItem, PriceStrategy, FetchResult, etc.
- Интерфейсы: Fetcher, Parser, Normalizer, Validator, DiscoveryStrategy, ProbeEngine, Scheduler, Spec, ScrapeRunContext
- Logger (pino) с pretty-print в dev и JSON в prod
- Config loader (zod-валидация env)
- Utils: parsePrice, formatPrice, normalizeName, sha256, htmlStructureHash
- Seed: регионы (moscow, mo, spb) + AppConfig singleton

**API endpoints:**
- GET /api/health — статус приложения (DB, config, region)
- GET /api/competitors — список конкурентов
- POST /api/competitors — добавить конкурента

**Frontend (Dashboard):**
- Header (sticky): лого, регион, кнопка "Добавить конкурента"
- 4 stat cards: Конкуренты, Услуги, Сборов сегодня, Alerts
- Competitors table с loading/empty/error states
- Add competitor dialog (TanStack Query mutation + toast)
- Recent activity timeline (заглушка)
- Footer (sticky bottom): версия, env, region, health badge
- Dark mode support, responsive (mobile-first), semantic HTML

### Что НЕ готово (Phase 1+)

- Probe Engine (автоопределение сайта)
- Discovery Engine (поиск URL с ценами)
- Parsers (Schema.org, cheerio, JSON-extract)
- Scheduler (cron)
- Self-healing
- VLM fallback

---
