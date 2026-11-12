import type { Candidate } from "./candidate-generator";
import { matchRules } from "./rule-matcher";
import type { Link } from "./types";
function allowedFor(a: string, b: string): string[] {
  const pair = [a, b].sort().join(":");
  const relation: Record<string, string> = { "act:contract": "references_contract", "addendum:contract": "amends_contract", "contract:invoice": "invoice_for_contract", "contract:kfz_report": "report_entry_for_contract", "contract:registry": "registry_entry_for_contract", "act:registry": "registry_entry_for_act", "act:kfz_report": "report_entry_for_act" };
  return relation[pair] ? [relation[pair]] : [];
}
export async function matchWithPolza(candidates: Candidate[], options: { apiKey: string; timeoutMs: number; model: string; maxCalls: number }): Promise<{ links: Link[]; calls: number; errors: number }> {
  const links: Link[] = []; let calls = 0, errors = 0;
  for (const c of candidates) {
    if (calls >= options.maxCalls) break;
    if (c.kind !== "document") continue;
    const base = matchRules(c); if (base.length) continue;
    const [a, b] = [c.a.extraction, c.b.extraction];
    const fields = (x: any) => Object.fromEntries(Object.entries(x.fields).map(([k, v]: [string, any]) => [k, { value: v.value, source_value: v.source_value, status: v.status, provenance: v.provenance }]));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      calls++;
      const allowed = allowedFor(a.document_type, b.document_type);
      if (!allowed.length) continue;
      const response = await fetch("https://polza.ai/api/v1/chat/completions", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: options.model, temperature: 0, max_tokens: 500, response_format: { type: "json_object" }, messages: [{ role: "system", content: "Предложи тип связи только если он прямо подтверждён данными. Ничего не додумывай. Верни JSON {relationship_type, source_document_id, target_document_id, evidence_paths:[{source_document_id,source_path,target_document_id,target_path}], explanation, confidence}. Ссылайся только на существующие извлечённые поля из переданных документов и их исходные значения/provenance. Если данных недостаточно, верни {relationship_type:null}." }, { role: "user", content: JSON.stringify({ documents: [{ document_id: a.document_id, document_type: a.document_type, fields: fields(a) }, { document_id: b.document_id, document_type: b.document_type, fields: fields(b) }], allowed_relationship_types: allowed }) }] }) });
      if (!response.ok) throw new Error(`Polza API HTTP ${response.status}`);
      const data: any = await response.json(), content = data.choices?.[0]?.message?.content;
      const proposed = JSON.parse(content || "{}");
      if (!proposed.relationship_type) continue;
      // Suggestions need to match the pair, allowed types and exact paths already present.
      if (![a.document_id, b.document_id].includes(proposed.source_document_id) || ![a.document_id, b.document_id].includes(proposed.target_document_id) || proposed.source_document_id === proposed.target_document_id || !allowed.includes(proposed.relationship_type) || !Array.isArray(proposed.evidence_paths) || !proposed.evidence_paths.length) continue;
      const docs = new Map([[a.document_id, a], [b.document_id, b]]);
      const ev = proposed.evidence_paths.map((item: any) => {
        if (!item || ![a.document_id, b.document_id].includes(item.source_document_id) || ![a.document_id, b.document_id].includes(item.target_document_id) || item.source_document_id === item.target_document_id || !String(item.source_path).startsWith("fields.") || !String(item.target_path).startsWith("fields.")) return null;
        const sourceDoc: any = docs.get(item.source_document_id), targetDoc: any = docs.get(item.target_document_id);
        const source: any = sourceDoc.fields[item.source_path.slice(7)], target: any = targetDoc.fields[item.target_path.slice(7)];
        if (!source || !target || source.status !== "extracted" || target.status !== "extracted" || !source.provenance || !target.provenance) return null;
        return { source: { document_id: sourceDoc.document_id, path: item.source_path, raw_value: source.value, normalized_value: String(source.value ?? "").toLowerCase(), provenance: source.provenance }, target: { document_id: targetDoc.document_id, path: item.target_path, raw_value: target.value, normalized_value: String(target.value ?? "").toLowerCase(), provenance: target.provenance }, signal: "llm_semantic_proposal", explanation: "Семантическая гипотеза требует проверки правилами" };
      });
      if (ev.some((e: any) => !e)) continue;
      const link: Link = { link_id: crypto.randomUUID(), relationship_type: proposed.relationship_type, source_document_id: proposed.source_document_id, target_document_id: proposed.target_document_id, evidence: ev, explanation: String(proposed.explanation ?? "Семантическая гипотеза требует проверки"), confidence: Math.min(.7, Math.max(.1, Number(proposed.confidence) || .5)), status: "proposed", verification_status: "not_reviewed", detection_method: "llm", conflicts: [] };
      const { validateEvidence } = await import("./evidence-validator");
      if (validateEvidence(link).valid) links.push(link);
    } catch { errors++; } finally { clearTimeout(timer); }
  }
  return { links, calls, errors };
}
