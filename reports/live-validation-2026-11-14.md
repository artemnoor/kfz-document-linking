# Live validation — 2026-11-14

## Checkpoint restoration

The Worker now checkpoints a successful Polza response before processing its fragment or relationship output. Restored calls reuse that saved response; processing acknowledges it and removes it from the checkpoint. This closes the interval where a process restart could repeat a completed, billable model call. Restored fragment budgets remain stable when the final context limit is raised, so existing fragment IDs and completed summaries remain valid. The final relationship pass uses compact navigation summaries and exact values for fact references, while original fragments remain available on request. The local mock regression interrupts immediately after the response checkpoint and verifies that restoration does not send the same fragment again.

Validation: `npm test` — 46 passed, 5 infrastructure/live tests skipped; `npm run typecheck`; `npm run build`.

## Synthetic live B

- Strategy: B; four synthetic Structured Extraction fixtures; Extraction calls: 0.
- Production system prompt SHA-256: `8b31e377cc4d8ce33bc4abba2ba07aaeccaac229bc09c8ab3e28b04a3e29f574`.
- Polza/Gemma calls: 2; reported cost: 0.10826244 RUB.
- Candidates: 1; emitted links: 0; diagnostics: 1. This confirms the live pipeline and evidence checks, not relationship accuracy.
- Artifact: `live-synthetic-B-2026-11-14.json`.

## Completed five-document live E2E on saved fixtures

The saved fixture outputs were sent directly to the production job API. No Extraction job was created. The five inputs were `act-2026-0424.json`, `contract-ambiguous-a.json`, `contract-ambiguous-b.json`, `act-ambiguous-1.json`, and `receipt-unknown-1.json`.

API → BullMQ → Worker → Polza/Gemma → PostgreSQL → scoped job GET completed with Linking contract 1.2.0. The result was persisted and read back: 3 model calls, 300,444 input tokens, 2,484 output tokens, reported cost 3.08477683 RUB, 0 links, and 3 evidence diagnostics.

Job: `56bdb1ba-0221-4ba1-b562-553b857bfeea`. Artifact: `live-five-saved-extractions-2026-11-14.json`.

## Completed live Linking on the five upstream Extraction results

The saved upstream outputs for `act`, `addendum`, `contract`, `invoice`, and `kfz` completed through the same API → BullMQ → Worker → Polza/Gemma → PostgreSQL → API readback path. The job continued from saved checkpoints across restarts; all 47 document fragments completed, followed by relationship analysis. Result: Linking 1.2.0, 54 recorded model calls, 1,167,791 input tokens, 184,402 output tokens, reported job cost 17.81243692 RUB, 9 links and 7 diagnostics. Extraction was not rerun.

Job: `ff966e41-5162-41cc-80bf-b39f9ac7691c`. Artifact: `live-five-upstream-extractions-recovery-2026-11-14.json`.

The separate four-document synthetic E2E also completed and was read back through the API: 2 calls, 0.11630707 RUB, output contract 1.2.0. Job: `4dda5ba4-dd16-4f95-8728-0dd7654f5fca`. Artifact: `live-synthetic-e2e-2026-11-14.json`.

## Real LLM regression after evidence-source validation fix

The live integration test was corrected to load the production prompt and accept the configured `POLZA_AI_API_KEY` alias. Re-running it against the saved contract and addendum Extraction fixtures completed with Gemma and the production prompt: 2 calls, 222,326 input tokens, 2,105 output tokens, reported cost 1.56825776 RUB, 2 links, and 3 evidence diagnostics. The prior `source_text_value_mismatch` false positives for nested normalized amounts disappeared. Remaining diagnostics were for missing evidence references and row IDs not traversed by the cited evidence paths; the existing correction/validation flow kept these visible instead of treating them as confirmed.

The general fix stores the owning Extraction entry's `source_value` with nested evidence references and compares that source representation to provenance OCR text. Legacy shapes without `source_value` still compare the cited scalar. A local regression covers both normalized amount formatting and genuine OCR mismatch. Validation: `npm test` — 49 passed, 3 skipped; `npm run typecheck`; live Polza integration passed.

## Initial malformed responses in the upstream run

The same upstream job first returned invalid JSON five times on its largest fragment, then was resumed with a smaller fragment budget. Usage for those malformed responses was not exposed in the original checkpoint, so total spend for the completed upstream run is higher than the reported 17.81243692 RUB by an unknown amount. The successful result is the final artifact linked above. Compose was returned to the normal 180,000-token / 52-call defaults after completion, and the temporary override file was removed.
