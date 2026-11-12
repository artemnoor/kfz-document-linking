import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { linkDocuments } from "../src/linking/link-resolver";
import { analyzeDocumentSet, GEMMA_MODEL } from "../src/linking/llm-matcher";
import { validateInput } from "../src/contracts/input";
import { linkingOutputSchema } from "../src/contracts/output";

const systemPrompt = readFileSync("public/prompts/document-linking-system.md", "utf8");
const fixtureDocs = readdirSync("fixtures/upstream-structured-extraction-1.2.0").filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(`fixtures/upstream-structured-extraction-1.2.0/${name}`, "utf8")));
test("complete upstream set is sent as one unfiltered Gemma context", async () => {
  const checked = validateInput(fixtureDocs); assert.equal(checked.success, true);
  const docs = checked.success ? checked.documents : [];
  const originalFetch = globalThis.fetch; let calls = 0; let sent: any;
  globalThis.fetch = async (_input, init) => { calls++; sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ links: [], unlinked_document_ids: docs.map(d => d.document_id), analysis_summary: "Reviewed all documents." }) } }], usage: { prompt_tokens: 1234, completion_tokens: 18 }, cost: 0.001 }), { status: 200 }); };
  try {
    const result = await analyzeDocumentSet(docs, { apiKey: "test-only", timeoutMs: 1000, maxCalls: 52, maxInputTokens: 999999, systemPrompt });
    assert.equal(calls, 1); assert.equal(sent.model, GEMMA_MODEL); assert.equal(sent.messages[1].content.includes('"source_cells"'), true);
    assert.deepEqual(JSON.parse(sent.messages[1].content.split("\n").slice(1).join("\n")).documents, docs);
    assert.equal(result.inputTokens, 1234); assert.equal(result.costAmount, 0.001); assert.deepEqual(result.unlinkedDocumentIds, docs.map(d => d.document_id));
  } finally { globalThis.fetch = originalFetch; }
});

test("large complete sets use Gemma document passes before whole-set relationship analysis", async () => {
  const docs = fixtureDocs, originalFetch = globalThis.fetch; let calls = 0, finalContext: any;
  globalThis.fetch = async (_input, init) => {
    calls++; const body: any = JSON.parse(String(init?.body)); const userText = body.messages[1].content;
    if (userText.startsWith("{")) { const fragment = JSON.parse(userText).document; return new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ fragments: [{ document_id: fragment.document_id, chunk_index: fragment.chunk_index, facts: [], summary: "studied" }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 }); }
    finalContext = JSON.parse(userText.slice(userText.indexOf("\n") + 1));
    return new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ links: [], unlinked_document_ids: docs.map(d => d.document_id), analysis_summary: "All reviewed." }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }), { status: 200 });
  };
  try {
    const result = await analyzeDocumentSet(docs as any, { apiKey: "test-only", timeoutMs: 1000, maxCalls: 52, maxInputTokens: 180000, systemPrompt });
    assert.ok(calls > 1); assert.equal(result.calls, calls); assert.equal(finalContext.documents.length, docs.length); assert.equal(result.unlinkedDocumentIds.length, docs.length);
  } finally { globalThis.fetch = originalFetch; }
});

test("completed Gemma document fragments persist and resume after an interrupted run", async () => {
  const docs = ["contract-ambiguous-a.json", "contract-ambiguous-b.json", "act-ambiguous-1.json", "receipt-unknown-1.json"].map(name => JSON.parse(readFileSync(`fixtures/demo-structured-extraction/${name}`, "utf8"))) as any[];
  const originalFetch = globalThis.fetch; let saved: any, firstCalls = 0;
  globalThis.fetch = async (_input, init) => {
    firstCalls++; const request: any = JSON.parse(String(init?.body)), user = request.messages[1].content;
    if (user.startsWith("{")) { const fragment = JSON.parse(user).document; return new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ fragments: [{ document_id: fragment.document_id, chunk_index: fragment.chunk_index, summary: "checkpoint", facts: [] }] }) } }], usage: { prompt_tokens: 11, completion_tokens: 4 } }), { status: 200 }); }
    return new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ links: [], unlinked_document_ids: docs.map(d => d.document_id), analysis_summary: "done" }) } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 });
  };
  try {
    const options = { apiKey: "test-only", timeoutMs: 1000, maxCalls: 52, maxInputTokens: 1800, systemPrompt: "short" };
    await analyzeDocumentSet(docs, { ...options, onProgress: async state => { saved = state; } });
    assert.equal(saved.completed_fragments.length, docs.length); assert.equal(saved.calls, docs.length + 1);
    const callsBeforeResume = firstCalls; let resumed: any;
    const result = await analyzeDocumentSet(docs, { ...options, resumeProgress: saved, onProgress: async state => { resumed = state; } });
    assert.equal(firstCalls - callsBeforeResume, 1); assert.equal(result.calls, saved.calls + 1); assert.equal(result.strategy, "document_fragments_then_full_set");
  } finally { globalThis.fetch = originalFetch; }
});

test("model choice is pinned and missing credentials fail without fallback", async () => {
  await assert.rejects(() => analyzeDocumentSet([], { apiKey: "test-only", timeoutMs: 10, maxCalls: 1, model: "other/model" }), /Разрешена только модель/);
  await assert.rejects(() => linkDocuments(fixtureDocs), /POLZA_API_KEY/);
});

test("invalid evidence paths and fabricated values are discarded", async () => {
  const docs = fixtureDocs.slice(0, 2), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ links: [{ relationship_type: "new_open_relationship", source_document_id: docs[0].document_id, target_document_id: docs[1].document_id, evidence: [{ source: { document_id: docs[0].document_id, path: "fields.does_not_exist", raw_value: "invented" }, target: { document_id: docs[1].document_id, path: "fields.contract_number", raw_value: "invented" } }], confidence: 1, status: "confirmed" }], unlinked_document_ids: [], analysis_summary: "" }) } }] }), { status: 200 });
  try { const result = await analyzeDocumentSet(docs as any, { apiKey: "test-only", timeoutMs: 1000, maxCalls: 52, maxInputTokens: 999999, systemPrompt }); assert.equal(result.links.length, 0); }
  finally { globalThis.fetch = originalFetch; }
});

test("LLM-only output satisfies the versioned stage 4 contract", async () => {
  const docs = fixtureDocs, originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ message: { content: JSON.stringify({ links: [], unlinked_document_ids: docs.map(d => d.document_id), analysis_summary: "Complete set reviewed." }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }), { status: 200 });
  try { const result = await linkDocuments(docs, { llm: { enabled: true, apiKey: "test-only", maxCalls: 52, maxInputTokens: 999999, systemPrompt } }); assert.equal(linkingOutputSchema.safeParse(result).success, true); assert.equal(result.contract_version, "1.1.0"); assert.equal(result.processing_metadata.llm.model, GEMMA_MODEL); }
  finally { globalThis.fetch = originalFetch; }
});
