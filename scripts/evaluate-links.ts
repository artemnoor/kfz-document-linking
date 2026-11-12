import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Ref = { document_id: string; path: string; raw_value?: unknown };
type Label = { relationship_type: string; source_document_id: string; target_document_id: string; source_row_id?: string | null; target_row_id?: string | null; evidence: { source: Ref; target: Ref }[] };
type Bundle = { annotations_complete: boolean; scenarios: { id: string; gold_links: Label[]; predictions_file: string }[] };
const args = process.argv.slice(2), annotationFlag = args.indexOf("--annotations"), bundlePath = annotationFlag >= 0 ? args[annotationFlag + 1] : args[0];
if (!bundlePath) throw new Error("Usage: npm run eval:links -- evaluation/annotations.json [--out evaluation/report.json]");
const bundle = JSON.parse(readFileSync(resolve(bundlePath), "utf8")) as Bundle;
if (!bundle.annotations_complete || !Array.isArray(bundle.scenarios) || bundle.scenarios.length === 0 || bundle.scenarios.some(s => !Array.isArray(s.gold_links) || !s.predictions_file)) {
  console.error("Метрики не измерены: независимая экспертная разметка неполная. Скопируйте annotations.template.json, заполните gold_links по исходным документам и установите annotations_complete=true после независимой проверки.");
  process.exit(2);
}
const key = (link: Label) => JSON.stringify([link.relationship_type, link.source_document_id, link.target_document_id]);
const pairKey = (link: Label) => JSON.stringify([link.relationship_type, ...[link.source_document_id, link.target_document_id].sort()]);
const rowKey = (link: Label) => JSON.stringify([link.relationship_type, link.source_document_id, link.target_document_id, link.source_row_id ?? null, link.target_row_id ?? null]);
const evidenceKeys = (link: Label) => new Set((link.evidence ?? []).flatMap(e => [JSON.stringify([e.source.document_id, e.source.path, e.source.raw_value]), JSON.stringify([e.target.document_id, e.target.path, e.target.raw_value])]));
let tp = 0, fp = 0, fn = 0, directionCorrect = 0, directionTotal = 0, rowCorrect = 0, rowTotal = 0, provenanceCorrect = 0, provenanceTotal = 0;
const byScenario: unknown[] = [];
for (const scenario of bundle.scenarios) {
  const result = JSON.parse(readFileSync(resolve(scenario.predictions_file), "utf8"));
  const gold: Label[] = scenario.gold_links, predicted: Label[] = result.links ?? [], unmatchedGold = new Set(gold.map((_, i) => i));
  for (const prediction of predicted) {
    const exact = gold.findIndex((label, i) => unmatchedGold.has(i) && key(label) === key(prediction));
    if (exact >= 0) { tp++; unmatchedGold.delete(exact); }
    else fp++;
    const candidate = gold.find(label => pairKey(label) === pairKey(prediction));
    if (candidate) { directionTotal++; if (key(candidate) === key(prediction)) directionCorrect++; rowTotal++; if (rowKey(candidate) === rowKey(prediction)) rowCorrect++; }
    const expectedRefs = gold.flatMap(label => label.evidence ?? []).flatMap(e => [JSON.stringify([e.source.document_id, e.source.path, e.source.raw_value]), JSON.stringify([e.target.document_id, e.target.path, e.target.raw_value])]);
    const actualRefs = evidenceKeys(prediction); if (expectedRefs.length) { provenanceTotal += expectedRefs.length; provenanceCorrect += expectedRefs.filter(ref => actualRefs.has(ref)).length; }
  }
  fn += unmatchedGold.size;
  byScenario.push({ id: scenario.id, gold: gold.length, predicted: predicted.length, true_positives: gold.length - unmatchedGold.size, false_positives: predicted.length - (gold.length - unmatchedGold.size), false_negatives: unmatchedGold.size });
}
const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
const report = { annotations_complete: true, scenarios: bundle.scenarios.length, links: { true_positives: tp, false_positives: fp, false_negatives: fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 }, direction_accuracy: { correct: directionCorrect, total: directionTotal, value: directionTotal ? directionCorrect / directionTotal : null }, row_matching_accuracy: { correct: rowCorrect, total: rowTotal, value: rowTotal ? rowCorrect / rowTotal : null }, provenance_accuracy: { correct: provenanceCorrect, total: provenanceTotal, value: provenanceTotal ? provenanceCorrect / provenanceTotal : null }, false_relationships: fp, per_scenario: byScenario };
console.log(JSON.stringify(report, null, 2));
const outFlag = args.indexOf("--out"); if (outFlag >= 0 && args[outFlag + 1]) writeFileSync(resolve(args[outFlag + 1]), `${JSON.stringify(report, null, 2)}\n`);
