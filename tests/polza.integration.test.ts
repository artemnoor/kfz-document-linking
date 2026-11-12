import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkDocuments } from "../src/linking/link-resolver";
import { linkingOutputSchema } from "../src/contracts/output";

const apiKey = process.env.POLZA_API_KEY;
test("real Polza DeepSeek V4 Flash integration uses valid upstream candidates", { skip: !apiKey }, async () => {
  const root = "fixtures/upstream-structured-extraction-1.2.0";
  const report = JSON.parse(readFileSync(`${root}/kfz-2026-q1.json`, "utf8"));
  const act = JSON.parse(readFileSync(`${root}/act-2026-0424.json`, "utf8"));
  const started = Date.now();
  const result = await linkDocuments([report, act], { llm: { enabled: true, apiKey, model: "deepseek/deepseek-v4-flash", timeoutMs: 20000, maxCalls: 1 } });
  assert.equal(result.processing_metadata.llm.provider, "Polza AI");
  assert.equal(result.processing_metadata.llm.model, "deepseek/deepseek-v4-flash");
  assert.equal(result.processing_metadata.llm.calls, 1, "An admissible report-act pair must reach Polza");
  assert.equal(result.processing_metadata.llm.errors, 0, "Polza should return a successful response");
  assert.equal(linkingOutputSchema.safeParse(result).success, true);
  assert.ok(result.links.filter(link => link.detection_method === "llm").every(link => link.status === "proposed" && link.verification_status === "not_reviewed"));
  console.log(JSON.stringify({ provider: "Polza AI", model: result.processing_metadata.llm.model, http_requests: result.processing_metadata.llm.calls, api_errors: result.processing_metadata.llm.errors, proposed_hypotheses: result.links.filter(link => link.detection_method === "llm").length, output_contract_valid: true, duration_ms: Date.now() - started }));
});
