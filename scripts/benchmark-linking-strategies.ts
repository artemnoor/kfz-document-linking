import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateInput, type Extraction } from "../src/contracts/input";
import { runLinkingStrategy, STRATEGY_PROMPTS, STRATEGY_PROMPT_VERSION, type ExperimentCall, type LinkingStrategy, type StrategyExperimentResult } from "../src/linking/strategy-experiments";
import { POLZA_MODEL } from "../src/linking/polza-client";

// Official Polza model page lists 7.26 RUB/M input and 39.9 RUB/M output. Reserve 2x
// those rates before each call; actual usage.cost takes precedence after every response.
const RUB_PER_INPUT_TOKEN = 0.00001452, RUB_PER_OUTPUT_TOKEN = 0.0000798;
const planPath = resolve("evaluation/strategy-pilot.json"), outputDir = resolve("reports/strategy-benchmark-runs");
const plan = JSON.parse(await readFile(planPath, "utf8")) as { version: string; budget_rub: number; repeats_per_scenario: number; strategies: LinkingStrategy[]; scenarios: { id: string; repeats?: number; description: string; fixture_directory: string; documents: string[] }[] };
const apiKey = process.env.POLZA_API_KEY ?? process.env.POLZA_AI_API_KEY;
if (!apiKey) throw new Error("POLZA_API_KEY не задан; платные тесты не запускались.");
await mkdir(outputDir, { recursive: true });
const systemPrompt = await readFile(resolve("prompts/document-linking-system.md"), "utf8");
const promptHash = createHash("sha256").update(systemPrompt).digest("hex");
const strategyPromptHash = createHash("sha256").update(JSON.stringify(STRATEGY_PROMPTS)).digest("hex");
const strategySourceHash = createHash("sha256").update(await readFile(resolve("src/linking/strategy-experiments.ts"))).digest("hex");
const results: { scenario: string; repeat: number; strategy: LinkingStrategy; result?: StrategyExperimentResult; error?: string; file: string; observedCalls?: ExperimentCall[]; attemptedCalls?: number; unpricedReserveRub?: number }[] = [];
const externalCalls: { label: string; calls: number; tokens: string; reported_cost_rub: number; included_in_strategy_rows: false }[] = [];
let actualSpend = 0, reservedSpend = 0, stopForBudget = false, totalCalls = 0, callsWithUsage = 0;
const ledgerPath = resolve(outputDir, "ledger.json");
const writeLedger = async () => writeFile(ledgerPath, `${JSON.stringify({ version: "1.0.0", model: POLZA_MODEL, provider: "Polza AI", budget_rub: plan.budget_rub, actual_or_estimated_spend_rub: Number(actualSpend.toFixed(8)), reserved_spend_rub: Number(reservedSpend.toFixed(8)), requests_attempted: totalCalls, responses_with_usage: callsWithUsage, requests_without_usage: totalCalls - callsWithUsage, stopped_for_budget: stopForBudget || results.some(row => row.error?.startsWith("BUDGET_STOP:")), external_live_checks: externalCalls, pricing_source: "https://polza.ai/models/google/gemma-4-26b-a4b-it", input_rate_rub_per_million: 14.52, output_rate_rub_per_million: 79.8, system_prompt_sha256: promptHash, strategy_prompts_version: STRATEGY_PROMPT_VERSION, strategy_prompts_sha256: strategyPromptHash, strategy_source_sha256: strategySourceHash, results: results.map(({ scenario, repeat, strategy, error, file }) => ({ scenario, repeat, strategy, error, file })) }, null, 2)}\n`);

// Resume from persisted spend and retain all earlier raw outputs; never reset the run budget.
try {
  const priorLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
  actualSpend = Number(priorLedger.actual_or_estimated_spend_rub) || 0;
  reservedSpend = Number(priorLedger.reserved_spend_rub) || 0;
  totalCalls = Number(priorLedger.requests_attempted ?? priorLedger.calls) || 0;
  callsWithUsage = Number(priorLedger.responses_with_usage ?? totalCalls) || 0;
  externalCalls.push(...(priorLedger.external_live_checks ?? []));
  for (const prior of priorLedger.results ?? []) {
    const artifact = JSON.parse(await readFile(resolve(outputDir, prior.file), "utf8"));
    results.push({ scenario: prior.scenario, repeat: prior.repeat, strategy: prior.strategy, file: prior.file, observedCalls: artifact.calls ?? [], attemptedCalls: artifact.attempted_calls ?? ((artifact.calls?.length ?? 0) + (artifact.error?.startsWith("BUDGET_STOP:") ? 0 : artifact.error ? 1 : 0)), unpricedReserveRub: artifact.unpriced_reserved_rub ?? 0, ...(artifact.result ? { result: artifact.result as StrategyExperimentResult } : {}), ...(prior.error ? { error: prior.error } : artifact.error ? { error: artifact.error } : {}) });
  }
} catch { /* New pilot; no previous ledger exists. */ }
const alreadyRun = new Set(results.map(row => `${row.scenario}:${row.repeat}:${row.strategy}`));

for (const scenario of plan.scenarios) {
  const raw = await Promise.all(scenario.documents.map(name => readFile(resolve(scenario.fixture_directory, name), "utf8").then(JSON.parse)));
  const checked = validateInput(raw);
  if (!checked.success) throw new Error(`Invalid fixture set ${scenario.id}: ${JSON.stringify(checked.diagnostics)}`);
  const documents: Extraction[] = checked.documents;
  for (let repeat = 1; repeat <= (scenario.repeats ?? plan.repeats_per_scenario) && !stopForBudget; repeat++) for (const strategy of plan.strategies) {
    if (stopForBudget) break;
    if (alreadyRun.has(`${scenario.id}:${repeat}:${strategy}`)) continue;
    const file = `${scenario.id}-repeat-${repeat}-${strategy}.json`, filePath = resolve(outputDir, file);
    const row: typeof results[number] = { scenario: scenario.id, repeat, strategy, file, observedCalls: [], attemptedCalls: 0, unpricedReserveRub: 0 }; results.push(row);
    alreadyRun.add(`${scenario.id}:${repeat}:${strategy}`);
    const reservations = new Map<string, number[]>();
    const updateArtifact = async (status: string) => writeFile(filePath, `${JSON.stringify({ version: "1.0.0", scenario: { id: scenario.id, description: scenario.description, fixture_files: scenario.documents }, repeat, strategy, provider: "Polza AI", model: POLZA_MODEL, prompt_version: "document-linking-system@" + promptHash.slice(0, 12) + "+strategy-prompts@" + STRATEGY_PROMPT_VERSION + "-" + strategyPromptHash.slice(0, 12), system_prompt_sha256: promptHash, strategy_prompts_sha256: strategyPromptHash, strategy_source_sha256: strategySourceHash, started_at: new Date().toISOString(), status, spend_rub_so_far: Number(actualSpend.toFixed(8)), calls: row.observedCalls, attempted_calls: row.attemptedCalls, unpriced_reserved_rub: Number((row.unpricedReserveRub ?? 0).toFixed(8)), result: row.result, error: row.error }, null, 2)}\n`);
    await updateArtifact("running"); await writeLedger();
    const reserve = async ({ label, estimatedInputTokens, maxOutputTokens }: { label: string; estimatedInputTokens: number; maxOutputTokens: number }) => {
      const amount = estimatedInputTokens * RUB_PER_INPUT_TOKEN + maxOutputTokens * RUB_PER_OUTPUT_TOKEN;
      if (actualSpend + reservedSpend + amount > plan.budget_rub) { stopForBudget = true; throw new Error(`BUDGET_STOP: резерв ${amount.toFixed(6)} RUB для ${label} превысит лимит ${plan.budget_rub} RUB (учтено ${actualSpend.toFixed(6)} + резерв ${reservedSpend.toFixed(6)})`); }
      reservedSpend += amount; reservations.set(label, [...(reservations.get(label) ?? []), amount]);
      row.attemptedCalls = (row.attemptedCalls ?? 0) + 1; row.unpricedReserveRub = (row.unpricedReserveRub ?? 0) + amount; totalCalls++;
      await updateArtifact("running");
    };
    const onCall = async (call: ExperimentCall) => {
      const pending = reservations.get(call.label) ?? [], held = pending.shift() ?? 0; reservations.set(call.label, pending); reservedSpend = Math.max(0, reservedSpend - held);
      row.unpricedReserveRub = Math.max(0, (row.unpricedReserveRub ?? 0) - held);
      const measured = typeof call.cost === "number" ? call.cost : call.input_tokens * RUB_PER_INPUT_TOKEN + call.output_tokens * RUB_PER_OUTPUT_TOKEN;
      if (call.currency && call.currency !== "RUB") throw new Error(`Неизвестная валюта стоимости ${call.currency}; эксперимент остановлен для соблюдения рублёвого бюджета.`);
      actualSpend += measured; callsWithUsage++;
      row.observedCalls!.push(call);
      await updateArtifact("running");
      await writeLedger();
      if (actualSpend + reservedSpend > plan.budget_rub) { stopForBudget = true; throw new Error(`BUDGET_STOP: фактический/оценочный расход превысил доступный остаток (${actualSpend.toFixed(6)} RUB)`); }
    };
    try {
      row.result = await runLinkingStrategy(strategy, documents, { apiKey, timeoutMs: 120_000, maxRunMs: 600_000, maxCalls: 8, maxEvidenceCorrectionAttempts: 2, maxInputTokens: 180_000, systemPrompt, beforeCall: reserve, onCall });
      await updateArtifact("complete");
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      if (row.error.startsWith("BUDGET_STOP:")) stopForBudget = true;
      await updateArtifact(stopForBudget ? "stopped_budget" : "failed");
      if (stopForBudget) break;
    }
    await writeLedger();
  }
}

const generatedAt = new Date().toISOString();
const completed = results.filter(row => row.result);
const graphKey = (link: any) => JSON.stringify([link.relationship_type, link.source_document_id, link.target_document_id, link.source_row_id ?? null, link.target_row_id ?? null]);
const stabilityFor = (scenario: string, strategy: LinkingStrategy) => {
  const repeats = completed.filter(row => row.scenario === scenario && row.strategy === strategy).map(row => {
    const result = row.result!;
    const candidates: any[] = strategy === "A" ? [...result.links, ...result.diagnostics.map(item => (item as any).proposal)] : result.candidates as any[];
    return new Set(candidates.filter(item => item && typeof item === "object").map(graphKey));
  });
  if (repeats.length < 2) return null;
  const scores: number[] = [];
  for (let i = 0; i < repeats.length; i++) for (let j = i + 1; j < repeats.length; j++) {
    const a = repeats[i], b = repeats[j], intersection = [...a].filter(key => b.has(key)).length, union = new Set([...a, ...b]).size;
    scores.push(union ? intersection / union : 1);
  }
  return Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4));
};
const metrics = (result: StrategyExperimentResult) => ({ candidates: result.candidates.length, accepted: result.links.length, confirmed: result.links.filter(link => link.status === "confirmed").length, proposed: result.links.filter(link => link.status === "proposed").length, review: result.links.filter(link => link.status === "review").length, rejected: result.links.filter(link => link.status === "rejected").length, diagnostics: result.diagnostics.length, valid_evidence_pairs: result.links.reduce((sum, link) => sum + link.evidence.length, 0), repaired_evidence: result.strategy === "A" ? result.diagnostics.filter(item => (item.proposal as any)?.resolution === "corrected").length : 0, calls: result.calls.length, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cost_rub: result.usage.cost_amount, duration_seconds: Number((result.duration_ms / 1000).toFixed(2)) });
const partialCandidateCount = (row: typeof results[number]) => {
  if (row.result) return row.result.candidates.length;
  const candidates = new Map<string, unknown>();
  for (const call of row.observedCalls ?? []) {
    const value = call.raw_response as any;
    const entries = row.strategy === "A" ? value?.links : value?.candidates;
    if (Array.isArray(entries)) for (const item of entries) if (item && typeof item === "object") candidates.set(JSON.stringify([item.relationship_type, item.source_document_id, item.target_document_id, item.source_row_id ?? null, item.target_row_id ?? null]), item);
  }
  return candidates.size ? candidates.size : "—";
};
const reportRows = results.map(row => ({ scenario: row.scenario, repeat: row.repeat, strategy: row.strategy, stability_mean_pairwise_jaccard: stabilityFor(row.scenario, row.strategy), ...(row.result ? metrics(row.result) : { candidates: partialCandidateCount(row), accepted: "—", confirmed: "—", proposed: "—", review: "—", rejected: "—", diagnostics: "—", valid_evidence_pairs: "—", repaired_evidence: "—", calls: row.attemptedCalls ?? row.observedCalls?.length ?? 0, input_tokens: row.observedCalls?.reduce((sum, call) => sum + call.input_tokens, 0) ?? 0, output_tokens: row.observedCalls?.reduce((sum, call) => sum + call.output_tokens, 0) ?? 0, cost_rub: (row.observedCalls ?? []).reduce((sum, call) => sum + (call.cost ?? 0), 0) + (row.unpricedReserveRub ?? 0), duration_seconds: row.observedCalls?.reduce((sum, call) => sum + call.duration_ms, 0) ? Number(((row.observedCalls?.reduce((sum, call) => sum + call.duration_ms, 0) ?? 0) / 1000).toFixed(2)) : "—", error: row.error ?? "not run" }) }));
const budgetWasHit = stopForBudget || results.some(row => row.error?.startsWith("BUDGET_STOP:"));
const nonBenchmarkCost = externalCalls.reduce((sum, call) => sum + call.reported_cost_rub, 0);
const md = [
  "# Document Linking strategy pilot", "", `Generated: ${generatedAt}`, `Model: \`${POLZA_MODEL}\` via Polza AI`, `New-request budget: ${plan.budget_rub} RUB; reported or estimated calls: ${actualSpend.toFixed(6)} RUB; reserved upper bound for requests without returned usage: ${reservedSpend.toFixed(6)} RUB; total budget exposure: ${(actualSpend + reservedSpend).toFixed(6)} RUB.`, `Requests attempted: ${totalCalls}; responses with usage: ${callsWithUsage}; without usage: ${totalCalls - callsWithUsage}.`, `Prompt versions: document-linking-system SHA-256 \`${promptHash}\`; experiment prompts ${STRATEGY_PROMPT_VERSION} SHA-256 \`${strategyPromptHash}\`.`, "",
  "## Runs", "", "| Bundle | Repeat | Approach | Candidates | Links emitted | Confirmed | Proposed | Review | Rejected | Diagnostics | Evidence pairs | Corrected | Calls | Input / output tokens | Cost (RUB) | Duration (s) | Stability Jaccard |", "|---|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...reportRows.map(row => "| " + [row.scenario, row.repeat, row.strategy, row.candidates ?? "—", row.accepted ?? "—", row.confirmed ?? "—", row.proposed ?? "—", row.review ?? "—", row.rejected ?? "—", row.diagnostics ?? "—", row.valid_evidence_pairs ?? "—", row.repaired_evidence ?? "—", row.calls ?? "—", `${row.input_tokens ?? "—"} / ${row.output_tokens ?? "—"}`, typeof row.cost_rub === "number" ? row.cost_rub.toFixed(6) : "unknown", row.duration_seconds ?? "—", row.stability_mean_pairwise_jaccard ?? "n/a", row.error ? String(row.error).replaceAll("|", "/") : ""].join(" | ") + " |"), "",
  "## Comparison", "", "On the actual Structured Extraction contract/addendum set, A emitted one confirmed relationship with two diagnostics. B emitted three relationships (two confirmed and one review) from four candidates, also with two diagnostics. These are model outputs, not correctness findings: there is no independent label to determine whether B found an omission or added a false relation. C completed its first independent pass on this large set (one request, one candidate, 0.956273 RUB) but the second independent request was stopped by the preflight budget guard; this is not a completed C result.", "", "On the four-document demo bundle (which intentionally lacks source provenance), A emitted no links in all three runs. B emitted 3, 3, and 4 candidates, with no links passing evidence checks. Its candidate-graph mean pairwise Jaccard is 0.0667. A's mean candidate-graph Jaccard is 0.1667. Those low values show unstable candidate sets in this tiny sample; neither is a quality metric. The accepted graphs are empty for both, so their accepted-link stability alone would be trivially 1.", "", "C completed one demo run: it unioned six candidates, the critic requested one debate round, and the evidence pass emitted zero links because the fixture had no usable provenance. That run used five requests, 15,709 input and 3,961 output tokens, 0.223212 RUB, and 116.27 seconds. The same strategy also had one malformed-JSON run and one timeout run. Compared with B's two requests / 0.068–0.095 RUB / 10–17 seconds per run, this is a clear cost and latency increase in the pilot, but the lack of gold labels and provenance means it does not show whether critic/debate improves correctness.", "", "The historic baseline report recorded 0–2 accepted links on repeated contract/addendum runs. Current A produced one confirmed link plus two diagnostics, consistent with the most recent earlier result (one accepted, two diagnostics). B's larger output has not been independently checked. No correct, false, or missed relationship examples can be designated without annotators; the observed A/B relationship-type disagreement is preserved in the raw artifacts for blind review.", "",
  "## Interpretation", "", "Precision, recall, F1, direction accuracy, row matching accuracy, false relationships and missed relationships are not measured: this repository has no independently adjudicated gold labels for these exact bundles. Model output is not treated as gold.", "", "Evidence diagnostics are technical failures/warnings retained with candidate records; they do not establish semantic false positives. An accepted relationship means only that its cited evidence passed the available technical registry/provenance checks. Candidate counts and emitted links are not labels of correctness.", "", "Repeat stability is a candidate-graph Jaccard across runs, using accepted and diagnostically retained proposals for A and all discovered candidates for B/C. Empty or sparse graphs can make Jaccard uninformative; it is not a quality metric.", "", "There is not a comparable repeated sample across all three strategies, and no winner is determined.", "", `A budget guard stopped at least one planned request: ${budgetWasHit ? "yes; the rejected preflight request was not sent" : "no"}.`, `Additional live smoke/integration requests run during npm test: ${externalCalls.reduce((sum, call) => sum + call.calls, 0)} requests, ${nonBenchmarkCost.toFixed(6)} RUB; these are included in the budget ledger but not in A/B/C row metrics.`, "",
  "## Raw artifacts", "", "Each JSON file in `reports/strategy-benchmark-runs/` records model responses when returned to the client, technical diagnostics, prompt version, per-call token/cost/time data, attempts, and run state. One invalid-JSON response in the first C demo attempt predates the raw-error observer hook and its text was not retained; its conservative preflight reserve remains in the ledger. Timed-out requests also have no response body. No key is saved.", "",
  "## Limitations", "", "This is a small pilot on fixed fixture inputs, not an independently labelled benchmark. Reported costs from Polza are used when available; requests with no usage because of invalid JSON or timeout retain their full preflight reserve as a conservative cost bound. Rates are twice the published Polza model page prices (input 14.52 RUB/M, output 79.8 RUB/M). A request is pre-reserved before sending; a strategy may remain partial if the remaining budget is insufficient.", "",
].join("\n");
await writeFile(resolve("reports/linking-strategy-benchmark.md"), md);
await writeLedger();
console.log(JSON.stringify({ spend_rub: actualSpend, budget_rub: plan.budget_rub, total_calls: totalCalls, stopped_for_budget: stopForBudget, results: reportRows }, null, 2));
