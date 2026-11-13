# Gemma relationship quality benchmark

This benchmark requires independent expert labels. Do not use Gemma responses, previous predictions, or model-generated summaries to create the gold set. Review the original Structured Extraction documents first, preferably with two annotators and an adjudication pass. Keep reviewers blind to predictions until labels are frozen.

## Run protocol

1. Use the fixed scenario bundles listed in `scenarios.json`; keep the source JSON and its hashes with the benchmark release.
2. For each bundle, annotate all supported relationships, their direction, row IDs, and source/target evidence paths and raw values. An empty `gold_links` array is meaningful only after the reviewers confirm there are no supported links.
3. Run the same model configuration and prompt multiple times. Save each complete Document Linking JSON result outside the source fixture directory.
4. Add the prediction paths as `predictions_files` in `annotations.json`; the first run is scored against gold and all runs contribute to pairwise graph stability and usage/cost totals.
5. Set `annotations_complete` to `true` only after independent review and adjudication, then run `npm run eval:links -- evaluation/annotations.json --out evaluation/report.json`.

The scorer reports link precision/recall/F1, direction accuracy, row matching, provenance accuracy, false relationships, pairwise graph Jaccard stability, model request count, tokens, and provider-reported cost. If cost is missing for any run, the total cost is reported as `null` rather than treating missing usage as zero.

## Current state

No independent gold annotations are checked in. Therefore benchmark precision, recall, F1, direction, row, and provenance accuracy have not been measured. The Polza live smoke report is a technical integration check, not an evaluation dataset. The ten scenario descriptions in `scenarios.json` are a coverage plan, not labels.
