# Product Roadmap

## Продуктовая цель

MedPrice Tracker должен пройти путь от диагностики медицинских сайтов к
операционному мониторингу цен:

1. добавить конкурента;
2. определить тип сайта и стратегию сбора;
3. найти страницы с ценами;
4. извлечь услуги и цены;
5. сохранить проверяемый scrape-run;
6. показать изменения и проблемы в dashboard.

## Приоритеты

### P0 — Security & Delivery Foundation

Статус: in progress.

- SSRF guard для всех server-side fetch/probe входов.
- API-key protection для write/download endpoints.
- Удалить open localhost forwarding из Caddy.
- CI: install, Prisma generate, lint, typecheck, parser tests, build.
- Кроссплатформенный production build.

Definition of Done:

- `bun run lint`, `bun run typecheck`, `bun run build` проходят локально.
- CI повторяет те же проверки на pull request.
- Нельзя отправить probe/fetch на private, loopback, link-local или non-HTTP(S) URL.

### P1 — First Real Scrape Run

Статус: next.

- Raw-lake helper: сохранять HTML/JSON snapshot + metadata для аудита и offline debug.
- Validator implementation: `validateItem`, `validateBatch`, `evaluateHealth`, `validateScope`.
- Discovery Engine v1: sitemap-first URL discovery + category filter.
- Parser v1 для CMD (`schema_org`) как первый эталонный T1 case.
- Scrape runner v1: `ScrapeRun -> Service -> PriceSnapshot`.
- `POST /api/scrape-runs` для ручного запуска сбора.

Definition of Done:

- Для CMD можно выполнить полный цикл: competitor -> probe -> scrape -> persisted services/prices.
- Каждый fetch сохраняет raw snapshot с content hash.
- Scrape-run получает статус `success`, `partial` или `failed` на основании validation rules.

### P2 — Parser Coverage

Статус: planned.

- `data_attributes` parser для Gemotest.
- `css_class`/table parser для Veramed и Altamed+.
- `embedded_json` parser для Helix.
- SEO-block parser для Medsi services.
- Fixture-based parser tests: HTML snapshots вместо live-сайтов в CI.

Definition of Done:

- Минимум 4 эталонных конкурента дают стабильные normalized items.
- Parser tests не зависят от внешней сети.

### P3 — Operator Dashboard

Статус: planned.

- Убрать stub timeline и подключить реальные `ScrapeRun`.
- API: `/api/stats`, `/api/scrape-runs`, `/api/services`, `/api/prices`.
- Actions в таблице конкурентов: `Probe`, `Scrape now`, `View spec`, `View services`.
- Детальная страница scrape-run: логи, counts, validation errors, raw snapshot links.
- Spec viewer/editor для auto-generated YAML.

Definition of Done:

- Dashboard показывает реальные runs, services, alerts и freshness.
- Оператор видит, почему scrape-run стал `partial` или `failed`.

### P4 — Normalization & Price Intelligence

Статус: planned.

- Canonical service names.
- Cross-source service matching.
- Price comparison table.
- Delta alerts: changed, added, removed services.
- Export: CSV/JSON for analysis.

Definition of Done:

- Можно сравнить цену одной услуги между несколькими конкурентами в выбранном регионе.

### P5 — Scheduling & Alerts

Статус: planned.

- Scheduler with per-competitor cron.
- Rate-limit and concurrency controls.
- Scrape alerts: failed run, items drop, 403/429, large price delta.
- Telegram notifications.

Definition of Done:

- Сбор может работать без ручного запуска и сообщает о значимых проблемах.

### P6 — Advanced Fetchers & Self-Healing

Статус: planned.

- PageReader/Playwright fetcher for SPA/lazy pages.
- Authenticated/session profile support where legally appropriate.
- Auto-reprobe on structure drift.
- Selector A/B testing.
- VLM fallback only for hard visual cases.

Definition of Done:

- T3-T8 сайты обрабатываются как fallback-путь, не ломая lean T1/T2 pipeline.

## Что заимствуем из Ecommerce_scrapperweb

- Offline processing from local HTML/zip -> переносим как fixture/raw-lake workflow.
- Raw page snapshot + assets -> переносим как auditable raw-lake, без копирования монолитного кода.
- Post-run validation -> переносим в `Validator` и `ScrapeRun` health.
- Deterministic naming helper -> используем для raw-lake keys, service slugs and fallback IDs.
- AI key/quota fallback -> переносим позже для z-ai LLM/VLM fallback.

Не переносим:

- e-commerce selectors;
- монолитную orchestration architecture;
- sync Playwright code;
- runtime package installation;
- asset download через browser navigation.
