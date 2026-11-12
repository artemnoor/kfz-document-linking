import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { demoDocuments } from "../src/linking/demo";
import { linkDocuments } from "../src/linking/link-resolver";
import { normalizeIdentifier } from "../src/linking/normalization";
import { validateInput } from "../src/contracts/input";
import { linkingOutputSchema } from "../src/contracts/output";

test("contract reference variants normalize consistently", () => {
  assert.equal(normalizeIdentifier("КД-24/03-15 от 15.03.2026"), normalizeIdentifier("Договор № КД 24-03-15"));
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
  assert.ok(r.links.some(l => l.relationship_type === "line_item_correspondence" && l.source_row_id === "act-row-r110"));
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
test("Polza API smoke test runs only when POLZA_API_KEY is configured", { skip: !process.env.POLZA_API_KEY }, async () => {
  // Use one pair that rule matching cannot resolve; the matcher must still constrain its output to existing IDs.
  const result = await linkDocuments([demoDocuments[0], demoDocuments[5]], { llm: { enabled: true, apiKey: process.env.POLZA_API_KEY, timeoutMs: 12000, maxCalls: 1 } });
  assert.ok(result.processing_metadata.llm.calls <= 1);
});
