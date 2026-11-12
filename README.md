# KFZ Document Linking

Этап 4 связывает готовые результаты Structured Extraction. Он не принимает первичные PDF/Office-файлы, не запускает OCR или извлечение повторно и не выполняет сверку сумм.

## Контракт входа

Базовый upstream — [`artemnoor/kfz-structured-extraction-` на SHA `3459f9f9217e964822a1347ba8e92a3629e22fca`](https://github.com/artemnoor/kfz-structured-extraction-/commit/3459f9f9217e964822a1347ba8e92a3629e22fca). В `schema-registry.mjs` этой версии все типы имеют схему `1.2.0`. Источник хранит результаты через `GET /api/extractions/{id}` в поле `extraction`; Input Adapter принимает как сами JSON-объекты, так и этот envelope.

Сервис сохраняет upstream имена и значения полей. `contracts/` содержит версии и входную/выходную JSON Schema, `openapi.yaml` описывает API. `fixtures/upstream-structured-extraction-1.2.0/` содержит шесть настоящих результатов `rules_only`, полученных из текущего Structured Extraction кода на демонстрационных parser JSON предыдущего этапа. `fixtures/demo-structured-extraction/` — отдельные сценарии для интерфейса, в том числе неоднозначные связи и документ без пары. Добавочные поля в major 1 разрешены; несовместимый major и некорректные входы отклоняются с JSON-path диагностиками.

## Запуск на Windows

Требуется Node.js 22+ и npm.

```powershell
npm install
npm run build
npx wrangler d1 migrations apply DB --local --env local
npm run worker
```

Откройте http://127.0.0.1:8791. Для быстрых правок интерфейса запустите в отдельном окне `npm run dev` (Vite на `http://127.0.0.1:5173` проксирует `/api` на Worker `http://127.0.0.1:8791`). Скопируйте `.dev.vars.example` в `.dev.vars` и задайте длинный случайный `API_BEARER_TOKEN`; интерфейс попросит его в верхней панели. Для семантического режима задайте `POLZA_API_KEY` и `LLM_ENABLED=true`. Секреты остаются только в серверных переменных; без Polza правила работают офлайн.

## Использование

Загрузите несколько JSON-результатов Structured Extraction или нажмите «Открыть пример», затем «Найти связи». Просмотрите поля и provenance в панели доказательств, подтвердите/отклоните неоднозначные связи и скачайте результат через «Экспорт JSON».

```powershell
$body = Get-Content .\fixtures\upstream-structured-extraction-1.2.0\act-2026-0424.json -Raw | ConvertFrom-Json
$contract = Get-Content .\fixtures\upstream-structured-extraction-1.2.0\contract-2026-0315.json -Raw | ConvertFrom-Json
$payload = ConvertTo-Json -InputObject @($body, $contract) -Depth 100
$headers = @{ Authorization = 'Bearer <API_BEARER_TOKEN>'; 'Idempotency-Key' = 'local-act-contract-demo' }
Invoke-RestMethod http://127.0.0.1:8791/api/linking-runs -Method Post -Headers $headers -ContentType 'application/json' -Body $payload
```

## API и интеграция этапа 5

- `POST /api/linking-runs` — поиск связей; тело до 3 МиБ и 50 документов, повтор защищает `Idempotency-Key` или хеш содержимого.
- `GET /api/linking-runs/{id}` — получить сохранённый результат.
- `PATCH /api/linking-runs/{runId}/links/{linkId}` — ручная проверка со статусом `confirmed` или `rejected`.
- `GET /api/health` — health check.

Локальный Worker использует `.dev.vars` из примера. Для deployment задайте `API_BEARER_TOKEN` через `npx wrangler secret put API_BEARER_TOKEN`; получение и изменение запусков требуют bearer авторизацию. Worker ограничивает частоту запросов по IP; миграция 002_api_safety.sql добавляет идемпотентность и таблицу лимитов. Противоположное решение проверки нельзя записать поверх уже сохранённого.

Каждая связь хранит ID документов, пути вида `fields.contract_reference` или `line_items[0].description`, строковые ID и исходный provenance с обеих сторон. Следующий этап может найти конкретные показатели в связанных JSON, а затем перейти по `source_ref`, `source_part_id`, `page_no`, `bbox`, `sheet_name` или `cell_address`. Никакой преобразователь входных результатов для этого не нужен. Точный контракт — `contracts/output.schema.json`.

Storage D1 независим: проект владеет миграцией `migrations/0001_initial.sql` and `migrations/0002_api_safety.sql` и принимает JSON через API. Таблицы Structured Extraction он не читает.

Для Cloudflare deployment создайте собственную D1 базу командой `npx wrangler d1 create kfz-document-linking`, укажите выданный `database_id` в `wrangler.toml`, примените `npx wrangler d1 migrations apply DB --remote` и выполните `npm run deploy`.

## Проверки

```powershell
npm test
npm run test:polza
npm run typecheck
npm run build
```

Живой интеграционный тест Polza ограничен одним запросом за запуск. Записанный результат последнего прогона находится в `docs/polza-integration-test.md`. Для проверки нужен `POLZA_API_KEY`. Для локальной проверки интерфейса запустите Worker, откройте страницу, загрузите демонстрационный набор, выполните поиск, откройте доказательство и проверьте JSON экспорт.
