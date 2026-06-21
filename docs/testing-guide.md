# Полный сценарий тестирования MedPrice Tracker

Этот гайд проведёт тебя через полный цикл тестирования: от клонирования репозитория до проверки реального scrape-run на CMD Online.

## Предварительные требования

- **Bun** >= 1.0 ([установка](https://bun.sh/))
- **Node.js** >= 20 (опционально, для некоторых скриптов)
- **Git**
- Интернет (для live тестов на CMD)

---

## Этап 1: Установка (5 минут)

```bash
# 1. Клонируем репозиторий
git clone https://github.com/Voodootime/med-price-scraper.git
cd med-price-scraper

# 2. Создаём .env из шаблона
cp .env.example .env

# 3. Устанавливаем зависимости
bun install

# 4. Инициализируем БД
bun run db:push
bun run db:seed

# 5. Проверяем что lint проходит
bun run lint
# Ожидаемый вывод: "$ eslint ." (без ошибок)
```

---

## Этап 2: Запуск dev сервера (1 минута)

```bash
# В отдельном терминале
bun run dev
```

**Ожидаемый вывод:**
```
▲ Next.js 16.1.3 (Turbopack)
- Local:         http://localhost:3000
✓ Ready in ~1s
```

**Проверка:**
```bash
curl http://localhost:3000/api/health
```

**Ожидаемый JSON:**
```json
{
  "status": "ok",
  "region": "mo",
  "checks": [
    { "name": "database", "status": "ok", "latencyMs": 1 },
    { "name": "config", "status": "ok" }
  ]
}
```

---

## Этап 3: Офлайн-тесты (30 секунд)

Эти тесты НЕ требуют интернета — используют fixtures.

```bash
# 1. Parser test на CMD fixture (9 assertions)
bun run src/scraper/parsers/__test__/html-price-parser-cmd-test.ts

# Ожидаемый вывод:
# ✅ items.length: 1
# ✅ strategy: "schema_org"
# ✅ confidence: 95
# ✅ price: 81000 (810 ₽)
# 9 passed, 0 failed
```

```bash
# 2. URL classifier test
bun run src/scraper/discovery/__test__/url-classifier-test.ts
# Ожидаемый вывод: "url-classifier tests passed"

# 3. Validator test
bun run src/scraper/validation/__test__/validator-test.ts
# Ожидаемый вывод: "validator-test: ok"

# 4. Framework detector test
bun run src/scraper/strategies/__test__/framework-test.ts
# Ожидаемый вывод: тесты bitrix/next/angular проходят
```

---

## Этап 4: Dashboard через браузер

Открой в браузере: **http://localhost:3000**

**Что ты увидишь:**
- Header: "MedPrice Tracker" + "Регион: Московская область"
- 4 stat cards: Конкуренты (0), Услуги (0), Сборов сегодня (0), Alerts (0)
- Empty state: "Нет конкурентов. Добавьте первого..."
- Pipeline status (новый компонент)
- Footer: версия, env, region, health badge

**Интерактивный тест:**
1. Нажми кнопку "Добавить конкурента"
2. Заполни форму: name="CMD Online", baseUrl="https://www.cmd-online.ru"
3. Нажми "Добавить"
4. Проверь: в таблице появилась строка "CMD Online" со статусом "Новый"

---

## Этап 5: Probe Engine (2-3 минуты)

Probe Engine анализирует сайт и определяет его характеристики.

```bash
# Через API (нужен ID конкурента из Этапа 4)
COMPETITOR_ID=$(curl -s http://localhost:3000/api/competitors | python3 -c "import json,sys; print(json.load(sys.stdin)['competitors'][0]['id'])")
echo "Competitor ID: $COMPETITOR_ID"

# Запускаем probe
curl -X POST http://localhost:3000/api/probe \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"https://www.cmd-online.ru\"}" \
  --max-time 180 | python3 -m json.tool
```

**Ожидаемый результат:**
```json
{
  "probeResult": {
    "tier": "T1",
    "framework": "bitrix",
    "confidenceScore": 85,
    "regionStrategy": {
      "type": "url_path_segment",
      "mapping": { "moscow": "msk", "mo": "msk" }
    },
    "totalUrlsDiscovered": 30000,
    "bestStrategy": "css_class"
  },
  "specStatus": "active",
  "competitorStatus": "active"
}
```

**Проверь в dashboard:** статус конкурента изменился с "Новый" на "Активен", tier="T1 · Static"

---

## Этап 6: Scrape Run (боевой тест, 1-2 минуты)

Это ключевая проверка — полный цикл от URL до цены в БД.

### Вариант A: Через API

```bash
# Получи competitorId
COMPETITOR_ID=$(curl -s http://localhost:3000/api/competitors | python3 -c "import json,sys; print(json.load(sys.stdin)['competitors'][0]['id'])")

# Запусти scrape (maxUrls=3 для скорости)
curl -X POST http://localhost:3000/api/scrape-runs \
  -H "Content-Type: application/json" \
  -d "{\"competitorId\": \"$COMPETITOR_ID\", \"maxUrls\": 3}" \
  --max-time 300 | python3 -m json.tool
```

**Ожидаемый результат:**
```json
{
  "status": "success",
  "urlsPlanned": 3,
  "urlsSucceeded": 3,
  "itemsExtracted": 2,
  "itemsAdded": 2
}
```

### Вариант B: Через скрипт (без dev сервера)

```bash
# Быстрый тест с preset tier (без probe, 1 минута)
bun run src/scraper/run/__test__/m1-quick.ts
```

**Ожидаемый вывод:**
```
=== RESULT ===
{
  "status": "success",
  "itemsExtracted": 2,
  "itemsAdded": 2
}

Services: 2
Snapshots: 2
First service: externalId="130003", name="Иммуноглобулин Е в Подольске"
First snapshot: price=79000 (790 RUB), strategy=schema_org
```

---

## Этап 7: Проверка результатов

После scrape-run проверь API endpoints:

```bash
# 1. Список услуг
curl -s http://localhost:3000/api/services | python3 -m json.tool | head -20

# Ожидается: массив services с至少 1 элементом
# Каждый service имеет: externalId, name, nameRaw, url

# 2. Список цен
curl -s http://localhost:3000/api/prices | python3 -m json.tool | head -20

# Ожидается: массив priceSnapshots
# Каждый snapshot имеет: price (в копейках), currency="RUB", parseStrategy

# 3. Детали scrape-run
curl -s http://localhost:3000/api/scrape-runs | python3 -m json.tool | head -20

# Ожидается: массив scrapeRuns с status="success"

# 4. Dashboard summary
curl -s http://localhost:3000/api/dashboard/summary | python3 -m json.tool

# Ожидается: stats.competitors >= 1, stats.services >= 1
```

---

## Этап 8: Скачивание проекта

```bash
# Скачать только документацию (31 КБ)
curl -o docs.tar.gz http://localhost:3000/api/download/docs
tar -xzf docs.tar.gz

# Скачать весь проект (205 КБ)
curl -o project.tar.gz http://localhost:3000/api/download/project
tar -xzf project.tar.gz
```

---

## Быстрая проверка (one-liner)

Если хочешь прогнать всё быстро одной командой:

```bash
git clone https://github.com/Voodootime/med-price-scraper.git && \
cd med-price-scraper && \
cp .env.example .env && \
bun install && \
bun run db:push && \
bun run db:seed && \
bun run src/scraper/parsers/__test__/html-price-parser-cmd-test.ts && \
bun run src/scraper/run/__test__/m1-quick.ts
```

**Если последние 2 теста прошли — система работает!**

---

## Troubleshooting

### Проблема: `bun install` падает
```bash
# Решение: удалить lockfile и переустановить
rm bun.lock
bun install
```

### Проблема: `db:push` ошибка "DATABASE_URL"
```bash
# Проверь что .env создан
cat .env
# Должно быть: DATABASE_URL=file:./db/custom.db
```

### Проблема: dev сервер не запускается
```bash
# Проверь порт 3000
lsof -i :3000
# Убей процесс если занят
kill -9 <PID>
bun run dev
```

### Проблема: probe timeout
Probe занимает 2-3 минуты (sitemap 30k URL). Если timeout:
```bash
# Увеличь timeout в curl
curl --max-time 300 -X POST http://localhost:3000/api/probe ...
```

### Проблема: scrape-run возвращает 0 items
```bash
# Проверь логи dev сервера
tail -50 dev.log | grep -i error

# Возможные причины:
# 1. CMD сайт недоступен (проверь: curl https://www.cmd-online.ru)
# 2. Parser не нашёл цены (запусти fixture test)
# 3. Discovery не нашёл URL (проверь sitemap)
```

---

## Что проверять после каждого изменения

| Команда | Что проверяет |
|---|---|
| `bun run lint` | Код соответствует стандартам |
| `bun run typecheck` | TypeScript компилируется |
| `bun run test:parser` | Parser работает на фикстуре |
| `bun run test:validator` | Validator корректно отбрасывает мусор |
| `curl /api/health` | Сервер и БД живы |
| `curl /api/competitors` | Competitor создан |
| `curl /api/services` | Услуги сохранены |
| `curl /api/prices` | Цены извлечены |

---

## Ожидаемые результаты (cheat sheet)

| Метрика | Ожидаемое значение |
|---|---|
| Health status | `ok` |
| Region | `mo` |
| CMD tier | `T1` |
| CMD framework | `bitrix` |
| CMD confidence | `85` |
| CMD region strategy | `url_path_segment` |
| Scrape status | `success` |
| Items extracted | `>= 1` |
| Price strategy | `schema_org` |
| Price confidence | `95` |
| First price | `790 RUB` (Иммуноглобулин Е) или `810 RUB` (Глютен) |
