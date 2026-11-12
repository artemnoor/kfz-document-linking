import { validateEvidence } from "./evidence-validator";
import type { Link, LinkingResult, MatcherOptions } from "./types";
import { indexDocuments } from "./document-index";
import { generateCandidates } from "./candidate-generator";
import { matchRules } from "./rule-matcher";
import { matchWithPolza } from "./llm-matcher";
import { validateInput } from "../contracts/input";
export async function linkDocuments(raw: unknown, options: MatcherOptions = {}): Promise<LinkingResult> {
  const started = Date.now(), checked = validateInput(raw);
  if (!checked.success) throw Object.assign(new Error("Входные данные не соответствуют контракту Structured Extraction 1.2.0"), { status: 422, diagnostics: checked.diagnostics });
  const docs = checked.documents, index = indexDocuments(docs), candidates = generateCandidates(index);
  const links: Link[] = [], seen = new Set<string>();
  for (const candidate of candidates) for (const link of matchRules(candidate)) {
    const key = [link.relationship_type, link.source_document_id, link.target_document_id, link.source_row_id ?? "", link.target_row_id ?? ""].sort().join("|");
    if (seen.has(key)) continue; seen.add(key);
    const validation = validateEvidence(link);
    if (!validation.valid) { link.status = "review"; link.conflicts.push(...validation.issues); }
    links.push(link);
  }
  let llmCalls = 0, llmErrors = 0;
  if (options.llm?.enabled && options.llm.apiKey) {
    const llm = await matchWithPolza(candidates, { apiKey: options.llm.apiKey, timeoutMs: options.llm.timeoutMs ?? 12_000, maxCalls: options.llm.maxCalls ?? 8, model: options.llm.model ?? "deepseek/deepseek-v4-flash" });
    llmCalls = llm.calls; llmErrors = llm.errors;
    for (const link of llm.links) if (!links.some(x => x.source_document_id === link.source_document_id && x.target_document_id === link.target_document_id)) links.push(link);
  }
  const linked = new Set(links.filter(l => l.status !== "rejected").flatMap(l => [l.source_document_id, l.target_document_id]));
  const reviewRequired = links.filter(l => l.status === "review" || l.status === "proposed").map(l => ({ link_id: l.link_id, reason: l.status === "proposed" ? "LLM предлагает гипотезу, требующую ручной проверки" : "Недостаточно независимых доказательств для подтверждения", candidate_document_ids: [l.source_document_id, l.target_document_id] }));
  const warnings = llmErrors ? [`Polza AI: ошибок запросов — ${llmErrors}`] : [];
  return { linking_run_id: crypto.randomUUID(), contract_version: "1.0.0", created_at: new Date().toISOString(), input_documents: docs.map(d => ({ document_id: d.document_id, extraction_id: d.extraction_id, document_type: d.document_type, version: d.version, schema_version: d.schema_version, ...(typeof d.input_version === "number" ? { input_version: d.input_version } : {}), ...(typeof d.input_hash === "string" ? { input_hash: d.input_hash } : {}) })), links, review_required: reviewRequired, unlinked_documents: docs.filter(d => !linked.has(d.document_id)).map(d => ({ document_id: d.document_id, reason: "Подходящая связь не установлена по доступным доказательствам" })), warnings, processing_metadata: { engine_version: "0.1.0", llm: { enabled: !!options.llm?.enabled, provider: "Polza AI", model: options.llm?.model ?? "deepseek/deepseek-v4-flash", calls: llmCalls, errors: llmErrors }, duration_ms: Date.now() - started } };
}
