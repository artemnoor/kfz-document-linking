# Polza AI live integration record

## Run: 2026-11-12

- Requested model: `google/gemma-4-26b-a4b-it`
- Provider catalog lookup: successful, model ID present; Polza reports context length 262144 and maximum completion 32768.
- Authenticated smoke request: passed through the OpenAI-compatible chat completions endpoint using the Windows user environment key, mapped in-process from `POLZA_AI_API_KEY`.
- Requests: 1; model ID in response matched the requested model.
- Usage: 1216 input tokens, 451 output tokens; reported cost 0.03090755 RUB; duration 14.5 seconds.
- Output contract validation: passed.
- A second authenticated smoke request also passed: 1217 input tokens, 426 output tokens, 0.02427013 RUB, 5.66 seconds.
- A third authenticated smoke run via `npm run test:polza` passed: 1217 input tokens, 468 output tokens, 0.02555864 RUB, 6.46 seconds.
- Mock tests: verify that the complete set is passed in one request when it fits, multi-stage requests retain every document and source path, model selection is pinned, and fabricated evidence is discarded.

The smoke fixture is small and has no source provenance; it validates authentication, model availability, response parsing, and output shape, not link quality.

## Full-set API run: 2026-11-13

- Path: local Cloudflare Worker `POST /api/linking-runs`, then `GET /api/linking-runs/{id}`.
- Upstream fixtures: 6 documents, Structured Extraction 1.2.0.
- Result: HTTP 201; persisted result was retrieved through GET; output contract 1.1.0.
- Model: `google/gemma-4-26b-a4b-it`, Polza AI only.
- Strategy: document fragments analyzed by Gemma, then a whole-set relationship analysis.
- Model/API calls recorded: 43; 1,305,073 input tokens and 119,022 output tokens.
- Reported cumulative cost: 16.25492363 RUB; elapsed model-processing time across attempts: 964,442 ms.
- Output: 10 document/row links, 5 with row IDs, 10 evidence items; no documents marked unlinked.
- D1 checkpoint resume: the first attempt encountered a 90-second Polza request timeout after completed fragments had been saved. Retrying the same payload continued from those fragments. On successful persistence the checkpoint row was deleted.
- Technical output validation and GET round-trip: passed.
- Browser flow: uploaded two prepared extraction JSON files, ran the real analysis, saw the model's summary and the technical-validation warning, then downloaded and parsed the output JSON (contract 1.1.0).

The number of discovered links is an observed model result, not a quality score. There is no independently labeled gold set in this repository, so precision, recall, F1, direction accuracy, and semantic line-match accuracy have not been measured. They require expert-validated expected links and provenance labels; mock responses are not used as evidence of model quality.

Run the live smoke test with a Windows process/user environment variable named `POLZA_API_KEY` or `POLZA_AI_API_KEY`:

```powershell
npm run test:polza
```

Only aggregate usage and contract validation are printed; the credential and provider response are not persisted by the test.
