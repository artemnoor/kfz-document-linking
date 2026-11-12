import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { demoDocuments } from "../src/linking/demo";
import { linkDocuments } from "../src/linking/link-resolver";
import { compareIdentifier, normalizeIdentifier } from "../src/linking/normalization";
import { indexDocuments } from "../src/linking/document-index";
import { generateCandidates } from "../src/linking/candidate-generator";
import { matchWithPolza } from "../src/linking/llm-matcher";
import { validateInput } from "../src/contracts/input";
import { linkingOutputSchema } from "../src/contracts/output";

test("contract reference variants normalize consistently", () => {
  assert.equal(normalizeIdentifier("КД-24/03-15 от 15.03.2026"), normalizeIdentifier("Договор № КД 24-03-15"));
  assert.equal(compareIdentifier("КД-77-11-09", "КД-77-11-090"), "none");
  assert.equal(compareIdentifier("7712458032", "17712458032"), "none");
});
test("direct contract reference yields a proven link; matching amount alone never does", async () => {
  const input = structuredClone(demoDocuments.slice(0, 2)) as any[];
  input[0].fields.contract_amount = { value: 1000, source_value: "1000", status: "extracted", confidence: 1, provenance: null };
  input[1].fields.amount_due = { value: 1000, source_value: "1000", status: "extracted", confidence: 1, provenance: null };
  const r = await linkDocuments(input);
  assert.ok(r.links.some(l => l.relationship_type === "references_contract"));
  const amountEvidence = r.links.flatMap(l => l.evidence).filter(e => e.signal.includes("amount"));
  assert.equal(amountEvidence.length, 0);
});
test("row link requires matching extracted identifier and description; sum-only collision is ignored", async () => {
  const r = await linkDocuments(demoDocuments.slice(1, 3));
  assert.ok(r.links.some(l => l.relationship_type === "line_item_correspondence" && l.source_row_id === "reg-row-r110" && l.target_row_id === "act-row-r110"));
  assert.ok(r.links.filter(l => l.relationship_type === "line_item_correspondence").every(l => l.status === "review"), "row ID and description without source provenance or shared contract context must not auto-confirm");
  const changed = structuredClone(demoDocuments.slice(1, 3)) as any[];
  for (const item of changed[1].line_items) { item.identifier = { ...item.identifier, value: `OTHER-${item.row_id}`, source_value: `OTHER-${item.row_id}` }; item.description = { ...item.description, value: "Независимая услуга", source_value: "Независимая услуга" }; }
  assert.equal((await linkDocuments(changed)).links.filter(l => l.relationship_type === "line_item_correspondence").length, 0);
});
test("low confidence fields cannot establish links", async () => {
  const input = structuredClone(demoDocuments.slice(0, 2)) as any[];
  input[1].fields.contract_reference.confidence = .2;
  assert.equal((await linkDocuments(input)).links.length, 0);
});
test("missing contract numbers and similar but non-equal party names do not create links", async () => {
  const input: any[] = structuredClone(demoDocuments.slice(0, 2));
  input[0].fields.contract_number.status = "missing"; input[0].fields.contract_number.value = null; input[0].fields.contract_number.source_value = null;
  input[0].fields.contractor.value = "ООО ИнжКонтур Бета-2"; input[0].fields.contractor.source_value = "ООО ИнжКонтур Бета-2";
  input[1].fields.contract_reference.status = "missing"; input[1].fields.contract_reference.value = null; input[1].fields.contract_reference.source_value = null;
  assert.equal((await linkDocuments(input)).links.length, 0);
});
test("same document number across two counterparties remains review or is blocked by contradiction", async () => {
  const input = structuredClone(demoDocuments.slice(0, 2)) as any[];
  const second = structuredClone(input[0]); second.document_id = "contract-other-party"; second.extraction_id = "ext-other";
  second.fields.contractor_inn.value = "7800000000"; second.fields.contractor_inn.source_value = "7800000000";
  input[1].fields.contractor_inn = { ...input[0].fields.contractor_inn, value: "7712458032", source_value: "7712458032", provenance: null };
  const r = await linkDocuments([...input, second]);
  assert.equal(r.links.filter(l => l.relationship_type === "references_contract").length, 1);
});
test("repeated import identifiers are diagnosed; missing provenance is not invented", () => {
  const duplicate = validateInput([demoDocuments[0], demoDocuments[0]]);
  assert.equal(duplicate.success, false);
  const malformed = structuredClone(demoDocuments[0]) as any; malformed.fields.contract_number.provenance = { document_id: "elsewhere", source_text: "" };
  assert.equal(validateInput([malformed]).success, true); // schema-valid but evidence validation will refuse it
});
test("bad provenance keeps a candidate for human review instead of confirming it", async () => {
  const input = structuredClone(demoDocuments.slice(0, 2)) as any[];
  input[0].fields.contract_number.provenance = { document_id: "unrelated-document", source_text: "wrong source" };
  const r = await linkDocuments(input);
  assert.equal(r.links[0].status, "review");
  assert.ok(r.links[0].conflicts.some(message => message.includes("provenance")));
});
test("multiple plausible contracts without party evidence remain ambiguous", async () => {
  const input = structuredClone(demoDocuments.slice(0, 2)) as any[];
  const second = structuredClone(input[0]); second.document_id = "contract-second-candidate"; second.extraction_id = "ext-second";
  for (const doc of [input[0], second]) { doc.fields.contractor_inn.status = "missing"; doc.fields.contractor_inn.confidence = null; doc.fields.contractor_inn.value = null; doc.fields.contractor_inn.source_value = null; doc.fields.contractor_inn.provenance = null; }
  input[1].fields.contractor_inn = { ...input[1].fields.contractor_inn, status: "missing", confidence: null, value: null, source_value: null, provenance: null };
  const r = await linkDocuments([...input, second]);
  const links = r.links.filter(l => l.relationship_type === "references_contract");
  assert.equal(links.length, 2);
  assert.ok(links.every(l => l.status === "review"));
});
test("addendum link is typed separately from invoice; invoice does not imply payment", async () => {
  const r = await linkDocuments([demoDocuments[0], demoDocuments[3], demoDocuments[4]]);
  assert.ok(r.links.some(l => l.relationship_type === "amends_contract"));
  assert.ok(r.links.some(l => l.relationship_type === "invoice_for_contract"));
  assert.ok(r.links.every(l => !String(l.relationship_type).includes("paid")));
});
test("actual upstream results can be linked and emitted as the stage 4 output contract", async () => {
  const inputs = readdirSync("fixtures/upstream-structured-extraction-1.2.0").filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`fixtures/upstream-structured-extraction-1.2.0/${name}`, "utf8")));
  const result = await linkDocuments(inputs);
  assert.equal(result.input_documents.length, 6);
  assert.ok(result.links.length > 0);
  assert.ok(result.links.every(link => link.evidence.some(e => e.source.provenance || e.target.provenance)));
  assert.ok(result.links.some(link => link.relationship_type === "line_item_correspondence" && link.evidence.some(e => e.signal === "shared_contract_context")));
  assert.equal(linkingOutputSchema.safeParse(result).success, true);
});
test("relationship direction is stable when input document order changes", async () => {
  const pair = [demoDocuments[0], demoDocuments[1]];
  const forward = await linkDocuments(pair), reverse = await linkDocuments(pair.reverse());
  const a = forward.links.find(l => l.relationship_type === "references_contract"), b = reverse.links.find(l => l.relationship_type === "references_contract");
  assert.deepEqual([a?.source_document_id, a?.target_document_id], [b?.source_document_id, b?.target_document_id]);
  assert.deepEqual([a?.source_document_id, a?.target_document_id], ["act-2026-0424", "contract-2026-0315"]);
});
test("duplicate table copies of line_items are indexed only once and keep original table path as alias", () => {
  const pair: any[] = structuredClone(demoDocuments.slice(1, 3));
  pair[1].tables = [{ id: "table-copy", title: "Работы", role: "line_items", headers: [], rows: structuredClone(pair[1].line_items) }];
  const indexed = indexDocuments(pair);
  assert.equal(indexed[1].rows.length, pair[1].line_items.length);
  assert.ok(indexed[1].rows[0].aliases.some((p: string) => p.startsWith("tables[0].rows[0]")));
  assert.equal(generateCandidates(indexed).filter(c => c.kind === "row").length, 2);
});
test("rows from semantically unrelated table roles are not considered line-item candidates", () => {
  const pair: any[] = structuredClone(demoDocuments.slice(1, 3));
  pair[1].line_items = [];
  pair[1].tables = [{ id: "summary-only", title: "Итоги", role: "summary", headers: [], rows: structuredClone((demoDocuments[2] as any).line_items) }];
  const candidates = generateCandidates(indexDocuments(pair));
  assert.equal(candidates.filter(candidate => candidate.kind === "row").length, 0);
});
test("documents without a contract can link by a direct act reference", async () => {
  const actual = readdirSync("fixtures/upstream-structured-extraction-1.2.0").filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`fixtures/upstream-structured-extraction-1.2.0/${name}`, "utf8")));
  const report: any = structuredClone(actual.find((d: any) => d.document_type === "kfz_report"));
  const act: any = structuredClone(actual.find((d: any) => d.document_type === "act"));
  report.fields.act_reference = { ...report.fields.contract_reference, value: act.fields.act_number.value, source_value: act.fields.act_number.source_value, provenance: null };
  const result = await linkDocuments([act, report]);
  assert.ok(result.links.some(link => link.relationship_type === "report_entry_for_act" && link.source_document_id === report.document_id && link.target_document_id === act.document_id));
});
test("every supported relationship has a declared direction and at least one exercised scenario", async () => {
  const actual = readdirSync("fixtures/upstream-structured-extraction-1.2.0").filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`fixtures/upstream-structured-extraction-1.2.0/${name}`, "utf8")));
  const act = actual.find((d: any) => d.document_type === "act"), report = actual.find((d: any) => d.document_type === "kfz_report"), registry = actual.find((d: any) => d.document_type === "registry");
  for (const doc of [report, registry]) doc.fields.act_reference = { ...doc.fields.contract_reference, value: act.fields.act_number.value, source_value: act.fields.act_number.source_value, provenance: null };
  const result = await linkDocuments(actual);
  const actualTypes = new Set(result.links.map(link => link.relationship_type));
  for (const type of ["references_contract", "amends_contract", "invoice_for_contract", "registry_entry_for_act", "registry_entry_for_contract", "report_entry_for_act", "report_entry_for_contract", "line_item_correspondence"]) assert.ok(actualTypes.has(type as any), `Missing relationship scenario: ${type}`);
  assert.ok(result.links.every(link => link.source_document_id !== link.target_document_id));
});
test("invalid source availability and source text force review", async () => {
  const actual = readdirSync("fixtures/upstream-structured-extraction-1.2.0").filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`fixtures/upstream-structured-extraction-1.2.0/${name}`, "utf8")));
  const pair = actual.filter((d: any) => ["contract", "act"].includes(d.document_type));
  pair.find((d: any) => d.document_type === "contract").fields.contract_number.provenance.source_available = false;
  const result = await linkDocuments(pair);
  const link = result.links.find(l => l.relationship_type === "references_contract");
  assert.equal(link?.status, "review");
  assert.ok(link?.conflicts.some(message => message.includes("доступен")));
});
test("LLM candidates are bounded and hostile fabricated evidence is discarded", async () => {
  const docs = structuredClone(demoDocuments.slice(0, 2)) as any[];
  const candidates = generateCandidates(indexDocuments(docs));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ relationship_type: "references_contract", source_document_id: docs[0].document_id, target_document_id: docs[1].document_id, evidence_paths: [{ source_path: "fields.NOT_REAL", target_path: "fields.contract_number" }], explanation: "fake", confidence: 1 }) } }] }), { status: 200 }); };
  try {
    const response = await matchWithPolza(candidates, { apiKey: "test-only", timeoutMs: 2000, maxCalls: 1, model: "deepseek/deepseek-v4-flash" });
    assert.equal(calls, 1);
    assert.equal(response.links.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test("Polza outage is isolated and reported without losing deterministic results", async () => {
  const docs = structuredClone(demoDocuments.slice(0, 2)) as any[], candidates = generateCandidates(indexDocuments(docs)), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    const response = await matchWithPolza(candidates, { apiKey: "test-only", timeoutMs: 1000, maxCalls: 1, model: "deepseek/deepseek-v4-flash" });
    assert.equal(response.calls, 1); assert.equal(response.errors, 1); assert.equal(response.links.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
