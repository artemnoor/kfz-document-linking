import { compareDescription, compareIdentifier, normalizeIdentifier, normalizeText, usable, valueOf } from "./normalization";
import type { Candidate } from "./candidate-generator";
import type { Evidence, Link, RelationshipType } from "./types";

export const RELATION_DEFINITIONS: Record<string, { type: RelationshipType; source: string; target: string }> = {
  "act:contract": { type: "references_contract", source: "act", target: "contract" },
  "addendum:contract": { type: "amends_contract", source: "addendum", target: "contract" },
  "contract:invoice": { type: "invoice_for_contract", source: "invoice", target: "contract" },
  "contract:registry": { type: "registry_entry_for_contract", source: "registry", target: "contract" },
  "act:registry": { type: "registry_entry_for_act", source: "registry", target: "act" },
  "act:kfz_report": { type: "report_entry_for_act", source: "kfz_report", target: "act" },
  "contract:kfz_report": { type: "report_entry_for_contract", source: "kfz_report", target: "contract" },
  "kfz_report:registry": { type: "line_item_correspondence", source: "kfz_report", target: "registry" },
};
const docRefs: Record<string, string[]> = { kfz_report: ["contract_reference"], act: ["contract_reference"], invoice: ["contract_reference"], registry: ["contract_reference"], addendum: ["base_contract"] };
const contractParties: Record<string, { inn: [string, string][]; names: [string, string][] }> = {
  invoice: { inn: [["buyer_inn", "contractor_inn"], ["buyer_inn", "customer_inn"]], names: [["buyer", "contractor"], ["buyer", "customer"]] },
  kfz_report: { inn: [["supplier_inn", "contractor_inn"], ["customer_inn", "customer_inn"]], names: [["reporting_organization", "contractor"], ["customer", "customer"]] },
  act: { inn: [["contractor_inn", "contractor_inn"], ["customer_inn", "customer_inn"]], names: [["contractor", "contractor"], ["customer", "customer"]] },
  registry: { inn: [["supplier_inn", "contractor_inn"], ["supplier_inn", "customer_inn"], ["buyer_inn", "contractor_inn"], ["buyer_inn", "customer_inn"]], names: [["organization", "contractor"], ["counterparty", "customer"]] },
  addendum: { inn: [], names: [["party_1", "contractor"], ["party_1", "customer"], ["party_2", "contractor"], ["party_2", "customer"]] },
};
function definition(a: string, b: string) { return RELATION_DEFINITIONS[[a, b].sort().join(":")]; }
function entry(e: any, docId: string, path: string) { const v = valueOf(e); return { document_id: docId, path, raw_value: v, normalized_value: normalizeIdentifier(v), provenance: e?.provenance ?? null }; }
function evidence(a: any, aid: string, ap: string, b: any, bid: string, bp: string, signal: string, explanation: string): Evidence { return { source: entry(a, aid, ap), target: entry(b, bid, bp), signal, explanation }; }
function makeLink(c: Candidate, type: RelationshipType, source: { id: string; row?: any }, target: { id: string; row?: any }, ev: Evidence[], score: number, explanation: string, conflicts: string[] = []): Link {
  return { link_id: crypto.randomUUID(), relationship_type: type, source_document_id: source.id, target_document_id: target.id, ...(source.row ? { source_row_id: source.row.row_id } : {}), ...(target.row ? { target_row_id: target.row.row_id } : {}), evidence: ev, explanation, confidence: score, status: score >= .9 ? "confirmed" : "review", verification_status: "not_reviewed", detection_method: "rules", conflicts };
}
function cleanInn(e: any): string { return String(valueOf(e) ?? "").replace(/\D/g, ""); }
function directDocumentReference(c: Candidate, def: { type: RelationshipType; source: string; target: string }): Link[] {
  const sourceDoc = c.a.extraction.document_type === def.source ? c.a : c.b;
  const targetDoc = sourceDoc === c.a ? c.b : c.a;
  if (def.target === "contract") {
    const refKeys = docRefs[sourceDoc.extraction.document_type] ?? [];
    const contractNumber = targetDoc.values.contract_number;
    if (!usable(contractNumber)) return [];
    const found = refKeys.map(key => [key, sourceDoc.values[key]] as const).find(([, field]) => usable(field) && compareIdentifier(valueOf(field), valueOf(contractNumber)) !== "none");
    if (!found) return [];
    const [refKey, refField] = found;
    const ev = [evidence(refField, sourceDoc.extraction.document_id, `fields.${refKey}`, contractNumber, targetDoc.extraction.document_id, "fields.contract_number", compareIdentifier(valueOf(refField), valueOf(contractNumber)), "Извлечённая ссылка на договор совпала без сравнения по подстроке")];
    const party = contractParties[sourceDoc.extraction.document_type] ?? { inn: [], names: [] };
    let inn = false, name = false, conflict = false;
    for (const [fieldKey, contractKey] of party.inn) {
      const left = sourceDoc.values[fieldKey], right = targetDoc.values[contractKey];
      if (!usable(left) || !usable(right)) continue;
      const a = cleanInn(left), b = cleanInn(right);
      if (![10, 12].includes(a.length) || ![10, 12].includes(b.length)) continue;
      if (a === b) { inn = true; ev.push(evidence(left, sourceDoc.extraction.document_id, `fields.${fieldKey}`, right, targetDoc.extraction.document_id, `fields.${contractKey}`, "exact_inn", "Точный ИНН стороны подтверждает ссылку")); } else conflict = true;
    }
    for (const [fieldKey, contractKey] of party.names) {
      const left = sourceDoc.values[fieldKey], right = targetDoc.values[contractKey];
      if (usable(left) && usable(right) && normalizeText(valueOf(left)) === normalizeText(valueOf(right))) { name = true; ev.push(evidence(left, sourceDoc.extraction.document_id, `fields.${fieldKey}`, right, targetDoc.extraction.document_id, `fields.${contractKey}`, "exact_party_name", "Точное нормализованное наименование стороны согласуется")); }
    }
    if (conflict && !inn) return [];
    const conflicts = conflict ? ["Обнаружено противоречие ИНН стороны"] : [];
    return [makeLink(c, def.type, { id: sourceDoc.extraction.document_id }, { id: targetDoc.extraction.document_id }, ev, inn ? .97 : name ? .91 : .78, inn ? "Прямая ссылка и точный ИНН" : name ? "Прямая ссылка и точное наименование стороны" : "Прямая ссылка на номер; независимых подтверждений недостаточно", conflicts)];
  }
  // Relations that do not require a contract need a direct reference to the other document.
  const referenceKeys = ["act_number", "act_reference", "act_document_number", "document_reference", "source_document_number"];
  const targetKeys = ["document_number", "act_number", "number"];
  for (const sk of referenceKeys) for (const tk of targetKeys) {
    const sv = sourceDoc.values[sk], tv = targetDoc.values[tk];
    if (usable(sv) && usable(tv) && compareIdentifier(valueOf(sv), valueOf(tv)) !== "none") return [makeLink(c, def.type, { id: sourceDoc.extraction.document_id }, { id: targetDoc.extraction.document_id }, [evidence(sv, sourceDoc.extraction.document_id, `fields.${sk}`, tv, targetDoc.extraction.document_id, `fields.${tk}`, "explicit_document_number", "Прямая ссылка на номер документа совпала")], .92, "Связь подтверждена прямой ссылкой на номер документа")];
  }
  return [];
}
function sharedContract(c: Candidate): Evidence[] {
  const refs = (doc: any) => ["contract_reference", "base_contract", "contract_number"].map(key => ({ key, field: doc.values[key] })).filter(x => usable(x.field));
  for (const a of refs(c.a)) for (const b of refs(c.b)) if (compareIdentifier(valueOf(a.field), valueOf(b.field)) !== "none") return [evidence(a.field, c.a.extraction.document_id, `fields.${a.key}`, b.field, c.b.extraction.document_id, `fields.${b.key}`, "shared_contract_context", "Обе строки имеют совпадающий полный договорный идентификатор")];
  return [];
}
function rowMatch(c: Candidate): Link[] {
  const a = c.aRow, b = c.bRow, ev: Evidence[] = [], conflicts: string[] = [];
  const identifier = usable(a.identifier) && usable(b.identifier) ? compareIdentifier(valueOf(a.identifier), valueOf(b.identifier)) : "none";
  const description = usable(a.description) && usable(b.description) ? compareDescription(valueOf(a.description), valueOf(b.description)) : { kind: "none" as const, score: 0 };
  if (identifier === "none" && description.kind === "none") return [];
  if (identifier !== "none") ev.push(evidence(a.identifier, c.a.extraction.document_id, `${c.aPath}.identifier`, b.identifier, c.b.extraction.document_id, `${c.bPath}.identifier`, `${identifier}_row_identifier`, "Идентификаторы строк совпали"));
  if (description.kind !== "none") ev.push(evidence(a.description, c.a.extraction.document_id, `${c.aPath}.description`, b.description, c.b.extraction.document_id, `${c.bPath}.description`, `${description.kind}_description`, "Описания строк семантически согласуются"));
  const context = sharedContract(c); ev.push(...context);
  let quantitySupport = false;
  const qaKey = a.actual_quantity?.status === "extracted" ? "actual_quantity" : "quantity", qbKey = b.actual_quantity?.status === "extracted" ? "actual_quantity" : "quantity";
  const qa = a[qaKey], qb = b[qbKey];
  if (usable(qa) && usable(qb)) {
    if (String(valueOf(qa)) === String(valueOf(qb))) { quantitySupport = true; ev.push(evidence(qa, c.a.extraction.document_id, `${c.aPath}.${qaKey}`, qb, c.b.extraction.document_id, `${c.bPath}.${qbKey}`, "matching_quantity_support", "Количество совпадает как дополнительное доказательство")); }
    else conflicts.push("Количество строк противоречит");
  }
  if (usable(a.unit) && usable(b.unit)) {
    if (normalizeText(valueOf(a.unit)) !== normalizeText(valueOf(b.unit))) conflicts.push("Единицы измерения строк противоречат");
    else ev.push(evidence(a.unit, c.a.extraction.document_id, `${c.aPath}.unit`, b.unit, c.b.extraction.document_id, `${c.bPath}.unit`, "matching_unit_support", "Единицы измерения совпадают"));
  }
  const def = definition(c.a.extraction.document_type, c.b.extraction.document_type);
  if (!def) return [];
  const byType = new Map<string, typeof c.a>([[c.a.extraction.document_type, c.a], [c.b.extraction.document_type, c.b]]);
  const sourceDoc = byType.get(def.source)!, targetDoc = byType.get(def.target)!;
  const sourceRow = sourceDoc === c.a ? a : b, targetRow = sourceDoc === c.a ? b : a;
  const directedEvidence = sourceDoc === c.a ? ev : ev.map(item => ({ ...item, source: item.target, target: item.source }));
  const partyA = [c.a.values.contractor_inn, c.a.values.supplier_inn].find(usable), partyB = [c.b.values.contractor_inn, c.b.values.supplier_inn].find(usable);
  const innA = cleanInn(partyA), innB = cleanInn(partyB);
  if (partyA && partyB && [10, 12].includes(innA.length) && [10, 12].includes(innB.length) && innA !== innB) conflicts.push("ИНН сторон документов противоречат");
  const strong = identifier !== "none" && description.kind !== "none" && description.kind !== "approximate" && context.length > 0 && conflicts.length === 0;
  const score = strong ? (quantitySupport ? .98 : .94) : .72;
  return [makeLink(c, "line_item_correspondence", { id: sourceDoc.extraction.document_id, row: sourceRow }, { id: targetDoc.extraction.document_id, row: targetRow }, directedEvidence, score, strong ? "Идентификатор, описание и общий договорный контекст согласуются" : "Кандидат по строке требует ручной проверки; суммы не использовались", [...conflicts, ...(!context.length ? ["Общий договорный контекст не установлен"] : [])])];
}

export function matchRules(c: Candidate): Link[] {
  if (c.kind === "row") return rowMatch(c);
  const def = definition(c.a.extraction.document_type, c.b.extraction.document_type);
  return def && def.type !== "line_item_correspondence" ? directDocumentReference(c, def) : [];
}
