# KFZ Document Linking

Этап 4 анализирует результаты Structured Extraction и строит граф отношений между документами и их строками. Смысловые решения принимает только `google/gemma-4-26b-a4b-it` через Polza AI. TypeScript-код отвечает за передачу контекста, техническую проверку доказательств, фоновые задания и сохранение результата.

## Запуск на Windows 11 или VPS

Требуются Docker Engine/Desktop с Compose v2. Для вызова модели задайте `POLZA_API_KEY` в `.env`; само приложение, PostgreSQL и Redis работают локально и не требуют облачного аккаунта.

```powershell
Copy-Item .env.example .env
# Измените POSTGRES_PASSWORD и API_BEARER_TOKEN; укажите POLZA_API_KEY для LLM
docker compose up --build
```

Откройте http://localhost:3000. Сервисы `postgres` и `redis` имеют health checks, миграция запускается перед API и worker. Данные PostgreSQL и очередь Redis сохраняются в Compose volumes при перезапуске.

Без Polza key сервис и интерфейс запускаются, но запрос анализа вернёт явную ошибку конфигурации. Модель не заменяется другой моделью или локальной логикой.

Для остановки используйте `docker compose down`; для сохранения данных не удаляйте volumes через `docker compose down -v`.

## Разработка без Docker для приложения

Docker может запускать только PostgreSQL и Redis. Для Node.js требуется версия 22 или новее.

```powershell
Copy-Item .env.example .env
npm ci
docker compose up -d postgres redis
npm run migrate
npm run dev:api
```

В отдельных терминалах запустите `npm run dev:worker` и `npm run dev` (Vite). Откройте http://127.0.0.1:5173. Host-конфигурация из `.env` должна указывать на `localhost:5432` и `localhost:6379`; Compose передаёт контейнерам внутренние DNS адреса автоматически.

## Устройство

- `server/app.ts` — Hono API и раздача собранного frontend.
- `src/linking/` — Document Linking Engine, клиент Polza/Gemma и Evidence Validator.
- `server/storage.ts` — PostgreSQL transactions, прогресс, результаты и блокировка заданий.
- `server/queue.ts`, `server/worker.ts` — BullMQ/Redis и возобновляемая обработка.
- `migrations/postgres/` — версионированные SQL-миграции PostgreSQL.
- `src/ui/` — React интерфейс.

BullMQ восстанавливает stalled jobs после завершения процесса. PostgreSQL атомарно захватывает задание с lease, checkpoints содержат точное состояние многоэтапного анализа и usage. Задание продолжает обработку после временной ошибки с backoff; повторы используют ключи идемпотентности и сохранённый прогресс.

В контекст, который помещается, передаётся весь набор Structured Extraction. Для больших наборов Gemma изучает каждый фрагмент с исходными путями, затем может запросить исходный фрагмент по document ID и chunk index и пересмотреть связи. Сводки используются только для навигации; данные не обрезаются молча.

## Настройки

Основные параметры задаются в `.env`:

- `API_BEARER_TOKEN` — доступ к API.
- `POLZA_API_KEY` — ключ Polza AI. Допускается Windows environment variable `POLZA_API_KEY` или прежнее имя `POLZA_AI_API_KEY`.
- `DATABASE_URL`, `REDIS_URL` — подключения PostgreSQL и Redis.
- `LLM_MAX_INPUT_TOKENS` (по умолчанию 180000), `LLM_MAX_CALLS_PER_RUN` (до 52), `LLM_TIMEOUT_MS`, `LLM_MAX_RUN_MS` — лимиты обработки.
- `PORT`, `HOST` — адрес API (по умолчанию 3000 и `0.0.0.0`).

Модель закреплена на `google/gemma-4-26b-a4b-it`, endpoint — `https://polza.ai/api/v1/chat/completions`. Fallback провайдеров отключён. Стоимость, токены, фактическая модель, provider, длительность и число запросов сохраняются, если Polza сообщает usage.

## API

Все endpoints, кроме `/api/health`, требуют `Authorization: Bearer <API_BEARER_TOKEN>`.

- `POST /api/linking-jobs` — создать задание; ответ `202` содержит `job_id`. Поддерживает `Idempotency-Key`.
- `GET /api/linking-jobs/{id}` — статус, фаза, fragments, calls, token usage, стоимость или полный результат.
- `POST /api/linking-jobs/{id}/resume` — повторно поставить завершившееся ошибкой задание в очередь с сохранёнными checkpoints.
- `POST /api/linking-runs` — синхронный совместимый endpoint анализа.
- `GET /api/linking-runs/{id}` — получить сохранённый результат.
- `PATCH /api/linking-runs/{runId}/links/{linkId}` — подтвердить или отклонить связь специалистом.
- `GET /api/demo` — демонстрационные входы.
- `GET /api/health` — readiness проверки PostgreSQL и Redis.

Контракты Structured Extraction 1.2.0 и Document Linking 1.2.0 сохранены. Дополнительные поля будущих minor-версий Structured Extraction принимаются и сохраняются; неизвестная major-версия диагностируется. Результат включает документные/строковые ID, исходные пути, provenance, объяснения, статусы, уверенность, диагностику, историю использования модели и пригоден для Reconciliation.

## Проверки

```powershell
npm test
npm run test:contract
npm run typecheck
npm run build
docker compose up --build
npm run test:integration
```

Инфраструктурные integration tests используют `DATABASE_URL` и `REDIS_URL`; они проверяют PostgreSQL persistence, эксклюзивное получение задания и повтор BullMQ после временной ошибки. Их можно запустить на хосте, пока Compose поднял локальные сервисы.

`npm run test:polza` выполняет один небольшой настоящий запрос через Polza, если `POLZA_API_KEY` доступен в Windows environment или `.env`. Не запускайте `npm run test:polza:full` без необходимости: это отдельный многоэтапный анализ с большим числом платных запросов.

## Evaluation

Независимая разметка формата описана в `evaluation/annotations.schema.json`, а список тестовых сценариев — в `evaluation/scenarios.json`. Независимой gold-разметки в репозитории нет, поэтому precision, recall, F1, направление, сопоставление строк и точность provenance не измерены. После экспертной разметки отчёт строится командой `npm run eval:links -- evaluation/annotations.json`.
