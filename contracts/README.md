# Контракты данных

Входной контракт зафиксирован по `schema-registry.mjs` Structured Extraction 1.2.0, актуальный upstream SHA хранится в `versions.json`. Сервис принимает массив результатов извлечения; API-envelope `{ "extraction": result }` также распознаётся Input Adapter. Извлечения должны содержать исходные имена (`document_id`, `extraction_id`, `document_type`, `version`, `schema_version`, `classification`, `fields`, `tables`, типовые `line_items` / `payment_schedule` / `changes`, `missing_fields`, `review_required`). Поля-значения сохраняют `value`, `source_value`, `status`, `confidence`, `provenance` без переименования.

Неизвестные добавочные поля разрешены в пределах major `1`; версии ниже 1.2 и новый major отклоняются с адресными диагностическими ошибками. Невалидный provenance не исправляется. Версии контрактов этого сервиса и совместимость схемы этапа 2 описаны в `versions.json`.

- Входная JSON Schema: `input.schema.json`.
- Выходная JSON Schema этапа 4: `output.schema.json`.
- Настоящие результаты `rules_only`, выданные кодом Structured Extraction 1.2.0: `../fixtures/upstream-structured-extraction-1.2.0/`.
- Независимый набор демонстрационных случаев с неоднозначностью и документом без связи: `../fixtures/demo-structured-extraction/`.
- Отдельный пример результата этапа 4: `examples/linking-result.json`.

Результат сохраняет ID полей/строк и оригинальный provenance. Следующий этап может перейти от `source_document_id` + `source_row_id` и `evidence[].source/target.path` к исходному фрагменту, а затем прочитать извлечённые показатели. Сверка показателей не входит в этот API.
