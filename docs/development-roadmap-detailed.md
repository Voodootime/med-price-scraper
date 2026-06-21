# Детальная дорожная карта развития MedPrice Tracker

Дата актуализации: 2026-06-21.

## 1. Цель продукта

MedPrice Tracker должен решать одну практическую задачу:

1. пользователь указывает сайт медицинской организации;
2. система анализирует сайт и определяет лучший способ получения данных;
3. система находит страницы, API, embedded JSON, таблицы или документы с ценами;
4. система извлекает услуги, цены, регион, тариф и источник;
5. система сохраняет результат в нормализованную таблицу;
6. оператор видит качество сбора, ошибки, изменения цен и может повторить или скорректировать сбор.

Итоговый продукт должен быть не просто скриптом, а управляемой платформой для регулярного мониторинга цен медицинских услуг.

## 2. Текущее состояние билда

Текущий checkpoint находится в ветке `codex/p0-hardening` и draft PR `#1`.

Реализовано:

- базовый Next.js dashboard;
- Prisma schema и SQLite для локального хранения;
- справочник конкурентов;
- probe engine для анализа сайта;
- sitemap discovery;
- HTML price parser;
- scrape runner;
- validator;
- raw-lake для сохранения HTML-снапшотов;
- API для dashboard summary, stats, services, prices и scrape-runs;
- базовая защита от SSRF;
- API-key protection для write/download endpoints;
- CI workflow;
- production build script;
- product roadmap P0-P6.

Ограничения текущего состояния:

- CMD live smoke еще не доведен до стабильного успешного результата;
- discovery умеет ранжировать URL, но еще не умеет health-aware заменять 404/пустые страницы следующими кандидатами;
- parser покрывает основные HTML-стратегии, но требует боевых fixtures по каждому конкуренту;
- dashboard показывает реальные сущности, но еще не содержит полноценной детализации scrape-run;
- нет scheduler, alerts workflow, экспорта и cross-source matching.

## 3. Архитектурный принцип развития

Развитие идет через короткие проверяемые этапы:

1. сначала делаем один надежный end-to-end сценарий на реальном сайте;
2. затем расширяем покрытие парсеров и типов сайтов;
3. потом добавляем операторские инструменты;
4. после этого включаем регулярный мониторинг, алерты и self-healing.

Каждый этап должен оставлять систему в рабочем состоянии:

- `bun run lint` проходит;
- `bun run typecheck` проходит;
- релевантные тесты проходят;
- `bun run build` проходит;
- новые scrape-сценарии имеют fixture или raw-lake sample для воспроизведения.

## 4. Milestone M1: стабильный первый боевой scrape-run

Приоритет: самый высокий.

Цель: для одного реального сайта пройти полный цикл `url -> probe -> discovery -> fetch -> parse -> validate -> persist -> dashboard`.

Основной кандидат: `https://www.cmd-online.ru`.

Задачи:

- добавить health-aware URL planning;
- при 404, 403, пустом HTML или нуле extracted items брать следующий URL-кандидат из discovery;
- сохранять в `ScrapeRun` не только planned URLs, но и фактически успешные/неуспешные candidates;
- добавить отдельный список `candidateErrors`;
- научить discovery учитывать региональные сегменты CMD: `msk`, `baksan`, `podolsk`, `balashikha` и другие;
- убрать предпочтение устаревших COVID-страниц, если они дают 404;
- проверить карточку CMD `peroralnyj_glukozotolerantnyj_test_300076`;
- адаптировать parser под фактическую HTML-структуру карточки CMD;
- добиться записи минимум одной услуги и одного `PriceSnapshot` в БД;
- добавить fixture test на HTML карточки CMD.

Definition of Done:

- `POST /api/scrape-runs` по CMD возвращает `success` или обоснованный `partial`, но не `failed` из-за нулевого результата;
- `itemsExtracted > 0`;
- `/api/services` возвращает сохраненную услугу;
- `/api/prices` возвращает актуальный price snapshot;
- raw-lake содержит HTML страницы, из которой извлечена цена;
- parser test на CMD fixture проходит без внешней сети.

Критерии качества:

- внешняя сеть нужна только для live smoke, но не для CI parser tests;
- 404 и пустые страницы не считаются фатальной ошибкой, пока есть резервные кандидаты;
- ошибка scrape-run должна объяснять, какие URL были отброшены и почему.

## 5. Milestone M2: покрытие эталонных конкурентов

Цель: расширить продукт с одного успешного сайта до набора медицинских сайтов разных типов.

Приоритетные сайты:

| Конкурент | Ожидаемый тип | Основной риск | Стратегия |
|---|---|---|---|
| CMD | T1/T1_schema_org, Bitrix | sitemap содержит устаревшие URL | schema.org, CSS, page card parser |
| Gemotest | T1/T2 | data attributes, региональность | data attributes parser |
| Helix | T2/T3 | embedded JSON, регион через cookie/IP | embedded JSON parser |
| Veramed | T1 | CSS/table structure | CSS/table parser |
| Altamed+ | T1 | простые HTML-блоки | CSS/table parser |
| Medsi | T2/T3/T9 | SEO-блоки, PDF/сложные страницы | SEO text parser, PDF fallback позже |

Задачи:

- собрать по 3-5 raw-lake snapshots на каждый сайт;
- выделить fixtures из raw-lake;
- добавить parser tests по каждому конкуренту;
- расширить `PriceStrategyName` только при реальной необходимости;
- нормализовать `externalId`, `code`, `slug` и `nameRaw`;
- добавить validation thresholds на уровне конкурента;
- добавить smoke-команду для локальной проверки эталонного набора.

Definition of Done:

- минимум 4 конкурента дают стабильные normalized items;
- каждый parser имеет fixture test;
- CI не зависит от live-сайтов;
- live smoke можно запускать вручную и видеть результат в dashboard.

## 6. Milestone M3: operator dashboard v1

Цель: оператор должен понимать состояние пайплайна без чтения логов.

Задачи:

- добавить страницу списка scrape-runs;
- добавить детальную страницу scrape-run;
- показать planned URLs, fetched URLs, failed URLs и validation errors;
- показать ссылки на raw-lake snapshots;
- добавить страницу services по конкуренту;
- добавить страницу price history по услуге;
- добавить действия `Probe`, `Scrape now`, `View runs`, `View services`;
- добавить визуальные статусы: `new`, `probing`, `active`, `needs_review`, `blocked`;
- добавить фильтры по конкуренту, статусу, региону и дате.

Definition of Done:

- оператор видит, почему run стал `failed` или `partial`;
- оператор может запустить probe/scrape из UI;
- оператор может открыть список найденных услуг и цен;
- dashboard не показывает stub-данные.

## 7. Milestone M4: нормализация и сравнение цен

Цель: превратить набор сырых услуг в аналитическую таблицу.

Задачи:

- добавить canonical service name;
- добавить rules-based normalization для частых медицинских терминов;
- добавить `ServiceMatch` или аналогичную таблицу для связи услуг между конкурентами;
- добавить сравнение цен по региону;
- добавить статус услуги: new, active, missing, removed;
- добавить вычисление delta между последними snapshots;
- добавить экспорт CSV/JSON;
- добавить ручную корректировку matching через UI.

Definition of Done:

- можно выбрать услугу и увидеть цены у нескольких конкурентов;
- можно выгрузить таблицу цен;
- изменения цен показываются как delta в рублях и процентах;
- оператор может исправить неправильное сопоставление.

## 8. Milestone M5: scheduler и alerts

Цель: перейти от ручного запуска к регулярному мониторингу.

Задачи:

- добавить per-competitor schedule;
- добавить rate limit и concurrency controls;
- добавить очередь заданий или простой scheduler слой;
- добавить scrape alerts:
  - run failed;
  - items count резко упал;
  - price delta выше порога;
  - много 404/403/429;
  - изменилась структура HTML;
- добавить acknowledgement flow для alerts;
- добавить Telegram notifications;
- добавить retry policy.

Definition of Done:

- конкурент может собираться по расписанию;
- alerts появляются в dashboard;
- оператор может подтвердить alert;
- Telegram сообщает о критичных ошибках.

## 9. Milestone M6: advanced fetchers

Цель: покрыть сайты, где статического HTML недостаточно.

Задачи:

- добавить Playwright fetcher для SPA/lazy страниц;
- добавить HAR/network capture для поиска JSON API;
- добавить API fetcher, если endpoint доступен без нарушения правил сайта;
- добавить PDF/XLSX/DOCX extractor для прайс-листов;
- добавить VLM fallback только для визуально сложных случаев;
- добавить proxy/session profile только там, где это законно и нужно;
- добавить tier-based router: T1/T2 идут через cheap static path, T3+ через fallback.

Definition of Done:

- T1/T2 сайты не замедляются из-за тяжелых fetchers;
- T3/T4 сайты получают fallback-путь;
- каждый heavy fetcher имеет лимиты стоимости и времени;
- raw artifacts сохраняются для аудита.

## 10. Milestone M7: self-healing и schema inference

Цель: система должна сама замечать поломку селекторов и предлагать восстановление.

Задачи:

- хранить `htmlStructureHash`;
- сравнивать структуру текущего HTML с предыдущей;
- запускать partial reprobe при structure drift;
- тестировать несколько parser strategies на sample pages;
- сохранять auto-generated scrape spec с versioning;
- добавить spec viewer/editor;
- добавить approve/reject workflow для новых specs;
- добавить regression tests из raw-lake samples.

Definition of Done:

- при изменении верстки система не молча пишет нули;
- новый spec можно проверить и принять через UI;
- старый spec остается доступен для отката.

## 11. Приоритеты на ближайшие итерации

### Итерация 1

Фокус: CMD end-to-end.

Задачи:

- health-aware candidate loop;
- CMD fixture;
- CMD parser tuning;
- successful scrape-run;
- services/prices API smoke.

Ожидаемый результат:

- первый реальный сохраненный price snapshot.

### Итерация 2

Фокус: повторяемость.

Задачи:

- raw-lake to fixture workflow;
- parser tests по CMD;
- детальная страница scrape-run;
- visibility для failed candidates.

Ожидаемый результат:

- ошибку можно воспроизвести без live-сайта.

### Итерация 3

Фокус: второй и третий конкурент.

Задачи:

- Gemotest parser;
- Veramed или Altamed+ parser;
- fixtures;
- smoke набор.

Ожидаемый результат:

- минимум 3 конкурента в dashboard с реальными services/prices.

### Итерация 4

Фокус: аналитическая ценность.

Задачи:

- canonical names;
- price comparison table;
- CSV export;
- delta display.

Ожидаемый результат:

- продукт можно использовать для ручного анализа рынка.

## 12. Риски и меры контроля

| Риск | Последствие | Контроль |
|---|---|---|
| Sitemap содержит устаревшие URL | Нулевой scrape или много 404 | health-aware candidate loop |
| Цена зависит от региона | Неверная цена | region strategy и scope validation |
| Верстка изменилась | Parser возвращает 0 items | structure hash, reprobe, fixtures |
| Live-сайт блокирует запросы | 403/429 | rate limit, backoff, robots compliance |
| Parser дает false positives | Мусор в таблице | validation, min/max price, confidence |
| CI зависит от сети | нестабильные проверки | offline fixtures |
| Raw data содержит лишнее | риск утечки | raw-lake в `.gitignore`, controlled export |

## 13. Definition of Ready для боевого теста

Боевой тест можно считать корректным, если заранее определены:

- сайт и базовый URL;
- целевой регион;
- ожидаемая категория данных;
- лимит страниц;
- допустимое время выполнения;
- минимальное число ожидаемых items;
- способ проверки результата в dashboard и БД;
- критерии `success`, `partial`, `failed`.

Минимальный live smoke сценарий:

1. создать или найти competitor;
2. запустить probe;
3. запустить scrape-run с `maxUrls=3-10`;
4. проверить `ScrapeRun`;
5. проверить `/api/services`;
6. проверить `/api/prices`;
7. проверить raw-lake snapshots;
8. сохранить успешный HTML как fixture.

## 14. Definition of Done для версии v0.1

Версия `v0.1` готова, когда:

- минимум один конкурент стабильно проходит end-to-end;
- минимум 50 услуг сохранены в БД на live smoke;
- parser tests покрывают успешные и неуспешные HTML cases;
- dashboard показывает competitors, runs, services, prices и errors;
- build и CI проходят;
- документация описывает запуск, диагностику и ограничения;
- локальные secrets и runtime data не попадают в GitHub.

## 15. Definition of Done для версии v0.2

Версия `v0.2` готова, когда:

- минимум 4 конкурента покрыты fixtures;
- минимум 3 конкурента проходят live smoke;
- добавлено сравнение цен между конкурентами;
- есть CSV export;
- есть alerts по failed runs и резкому падению items count;
- оператор может понять и воспроизвести проблему без чтения исходного кода.

## 16. Решение по данным и хранению

В GitHub храним:

- исходный код;
- schema;
- migrations или schema definition;
- tests;
- fixtures без секретов;
- документацию;
- roadmap;
- CI.

Не храним в GitHub:

- `.env`;
- реальные токены;
- локальную SQLite DB;
- `.next`;
- raw-lake runtime snapshots;
- временные логи;
- персональные файлы оператора.

Для воспроизводимости используем:

- `.env.example`;
- seed scripts;
- parser fixtures;
- documented smoke commands;
- raw-lake metadata без публикации приватных данных.

## 17. Следующий конкретный шаг

Следующий engineering step:

1. реализовать health-aware candidate loop в `scrape-runner`;
2. прогнать CMD live smoke;
3. выбрать первую успешную карточку услуги;
4. сохранить HTML как fixture;
5. зафиксировать parser test;
6. добиться записи `Service` и `PriceSnapshot`;
7. обновить PR с результатом.
