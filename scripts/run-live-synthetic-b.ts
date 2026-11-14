import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateInput } from "../src/contracts/input";
import { runLinkingStrategy } from "../src/linking/strategy-experiments";

const apiKey = process.env.POLZA_API_KEY || process.env.POLZA_AI_API_KEY;
if (!apiKey) throw new Error("POLZA_API_KEY не задан; live synthetic B не запускался.");
const fixtureDirectory = resolve("fixtures/demo-structured-extraction");
const fixtureFiles = ["contract-ambiguous-a.json", "contract-ambiguous-b.json", "act-ambiguous-1.json", "receipt-unknown-1.json"];
const raw = await Promise.all(fixtureFiles.map(name => readFile(resolve(fixtureDirectory, name), "utf8").then(JSON.parse)));
const checked = validateInput(raw);
if (!checked.success) throw new Error(`Synthetic B fixtures invalid: ${JSON.stringify(checked.diagnostics)}`);
const systemPrompt = await readFile(resolve("prompts/document-linking-system.md"), "utf8");
const promptSha256 = createHash("sha256").update(systemPrompt).digest("hex");
const reservePerInputToken = 0.00002904, reservePerOutputToken = 0.0001596;
const budgetRub = 5;
let actualOrEstimatedSpendRub = 0, reservedRub = 0;
const reservations = new Map<string, number[]>();
const result = await runLinkingStrategy("B", checked.documents, {
  apiKey, timeoutMs: 120_000, maxRunMs: 300_000, maxCalls: 2, maxInputTokens: 180_000, systemPrompt,
  beforeCall: async ({ label, estimatedInputTokens, maxOutputTokens }) => {
    const reserve = estimatedInputTokens * reservePerInputToken + maxOutputTokens * reservePerOutputToken;
    if (actualOrEstimatedSpendRub + reservedRub + reserve > budgetRub) throw new Error(`Budget guard stopped ${label} before provider request.`);
    reservedRub += reserve;
    reservations.set(label, [...(reservations.get(label) ?? []), reserve]);
  },
  onCall: async call => {
    const pending = reservations.get(call.label) ?? [], held = pending.shift() ?? 0;
    reservations.set(call.label, pending); reservedRub = Math.max(0, reservedRub - held);
    const measured = call.cost ?? (call.input_tokens * reservePerInputToken + call.output_tokens * reservePerOutputToken);
    actualOrEstimatedSpendRub += measured;
    if (call.currency && call.currency !== "RUB") throw new Error(`Unexpected provider currency ${call.currency}; stopping.`);
  },
});
const report = {
  scenario: "synthetic-live-B",
  completed_at: new Date().toISOString(),
  fixture_files: fixtureFiles,
  extraction_invocations: 0,
  production_system_prompt_sha256: promptSha256,
  strategy: result.strategy,
  provider: "Polza AI",
  model: result.model,
  calls: result.calls,
  candidates: result.candidates.length,
  emitted_links: result.links.length,
  diagnostics: result.diagnostics.length,
  result,
  actual_or_estimated_spend_rub: Number(actualOrEstimatedSpendRub.toFixed(8)),
  remaining_reserved_rub: Number(reservedRub.toFixed(8)),
  budget_rub: budgetRub,
};
const outputPath = resolve("reports/live-synthetic-B-2026-11-14.json");
await mkdir(resolve("reports"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, scenario: report.scenario, extraction_invocations: 0, provider: report.provider, model: report.model, calls: result.calls.length, candidates: report.candidates, links: report.emitted_links, diagnostics: report.diagnostics, cost_rub: report.actual_or_estimated_spend_rub, budget_rub: budgetRub, production_prompt_sha256: promptSha256 }));
