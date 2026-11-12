import { normalizeIdentifier, normalizeText, usable, valueOf } from "./normalization";
import type { Candidate } from "./candidate-generator";
import type { Evidence, Link, RelationshipType } from "./types";
const docFields: Record<string, string[]> = {
  kfz_report: ["contract_reference"], act: ["contract_reference"], invoice: ["contract_reference"], registry: ["contract_reference"], addendum: ["base_contract"],
};
function role(a: string, b: string): RelationshipType | null {
  const pair = [a, b].sort().join(":");
  return ({ "act:contract": "references_contract", "addendum:contract": "amends_contract", "contract:invoice": "invoice_for_contract", "contract:kfz_report": "report_entry_for_contract", "contract:registry": "registry_entry_for_contract", "act:registry": "registry_entry_for_act", "act:kfz_report": "report_entry_for_act" } as Record<string, RelationshipType>)[pair] ?? null;
}
function entry(e: any, docId: string, path: string) { const v = valueOf(e); return { document_id: docId, path, raw_value: v, normalized_value: normalizeIdentifier(v), provenance: e?.provenance ?? null }; }
function evidence(left: any, leftId: string, leftPath: string, right: any, rightId: string, rightPath: string, signal: string, explanation: string): Evidence { return { source: entry(left, leftId, leftPath), target: entry(right, rightId, rightPath), signal, explanation }; }
function mk(c: Candidate, type: RelationshipType, ev: Evidence[], score: number, explanation: string, method: "rules" | "hybrid" = "rules"): Link {
  const dependent = c.a.extraction.document_type === "contract" ? c.b : c.a, parent = dependent === c.a ? c.b : c.a;
  return { link_id: crypto.randomUUID(), relationship_type: type, source_document_id: dependent.extraction.document_id, target_document_id: parent.extraction.document_id, ...(c.kind === "row" ? { source_row_id: c.a.extraction.document_id === dependent.extraction.document_id ? c.aRow.row_id : c.bRow.row_id, target_row_id: c.a.extraction.document_id === parent.extraction.document_id ? c.aRow.row_id : c.bRow.row_id } : {}), evidence: ev, explanation, confidence: score, status: score >= .85 ? "confirmed" : "review", verification_status: "not_reviewed", detection_method: method, conflicts: [] };
}
export function matchRules(c: Candidate): Link[] {
  if (c.kind === "row") {
    const ai = c.aRow.identifier, bi = c.bRow.identifier, ad = c.aRow.description, bd = c.bRow.description;
    if (!usable(ai) || !usable(bi) || normalizeIdentifier(valueOf(ai)) !== normalizeIdentifier(valueOf(bi))) return [];
    const ev = [evidence(ai, c.a.extraction.document_id, `${c.aPath}.identifier`, bi, c.b.extraction.document_id, `${c.bPath}.identifier`, "exact_identifier", "Совпал извлечённый идентификатор строки")];
    const namesAgree = usable(ad) && usable(bd) && (normalizeText(valueOf(ad)).includes(normalizeText(valueOf(bd))) || normalizeText(valueOf(bd)).includes(normalizeText(valueOf(ad))));
    if (namesAgree) ev.push(evidence(ad, c.a.extraction.document_id, `${c.aPath}.description`, bd, c.b.extraction.document_id, `${c.bPath}.description`, "description_support", "Наименование строки также согласуется"));
    const refsA = Object.entries(c.a.values).filter(([key, value]) => ["contract_reference", "base_contract", "contract_number"].includes(key) && usable(value));
    const refsB = Object.entries(c.b.values).filter(([key, value]) => ["contract_reference", "base_contract", "contract_number"].includes(key) && usable(value));
    let sharedContract = false;
    for (const [keyA, valueA] of refsA) for (const [keyB, valueB] of refsB) {
      const aValue = normalizeIdentifier(valueOf(valueA)), bValue = normalizeIdentifier(valueOf(valueB));
      if (aValue && (aValue === bValue || aValue.includes(bValue) || bValue.includes(aValue))) {
        ev.push(evidence(valueA, c.a.extraction.document_id, `fields.${keyA}`, valueB, c.b.extraction.document_id, `fields.${keyB}`, "shared_contract_context", "Обе строки принадлежат документам со ссылкой на один договор"));
        sharedContract = true;
        break;
      }
    }
    const partyA = c.a.values.contractor_inn ?? c.a.values.supplier_inn ?? c.a.values.organization_inn;
    const partyB = c.b.values.contractor_inn ?? c.b.values.supplier_inn ?? c.b.values.organization_inn;
    const conflict = usable(partyA) && usable(partyB) && normalizeIdentifier(valueOf(partyA)) !== normalizeIdentifier(valueOf(partyB));
    if (conflict) return [];
    const descriptionConflict = usable(ad) && usable(bd) && !namesAgree;
    const link = mk(c, "line_item_correspondence", ev, namesAgree && sharedContract && !descriptionConflict ? .94 : .72, namesAgree && sharedContract ? "Идентификатор строки, наименование и договорный контекст согласуются" : "Совпал идентификатор строки; требуется проверка описания и общего договорного контекста");
    if (descriptionConflict) link.conflicts.push("Описания строк расходятся");
    if (!sharedContract) link.conflicts.push("Общий договорный контекст не установлен");
    return [link];
  }
  const aType = c.a.extraction.document_type, bType = c.b.extraction.document_type, type = role(aType, bType);
  if (!type) return [];
  const refsA = docFields[aType] ?? [], refsB = docFields[bType] ?? [];
  const doc = aType === "contract" ? c.a : bType === "contract" ? c.b : null;
  const refDoc = doc === c.a ? c.b : c.a;
  const refKeys = doc === c.a ? refsB : refsA;
  const idKey = doc?.extraction.document_type === "contract" ? "contract_number" : null;
  if (!doc || !idKey) return [];
  const contractId = doc.values[idKey];
  if (!usable(contractId)) return [];
  const targetKey = Object.keys(refDoc.values).find(k => refKeys.includes(k) && usable(refDoc.values[k]) && normalizeIdentifier(valueOf(refDoc.values[k])).includes(normalizeIdentifier(valueOf(contractId))));
  if (!targetKey) return [];
  const ev = [evidence(refDoc.values[targetKey], refDoc.extraction.document_id, `fields.${targetKey}`, contractId, doc.extraction.document_id, `fields.${idKey}`, "explicit_document_reference", "Явная ссылка на номер договора совпадает с номером договора")];
  const dependentType = (c.a.extraction.document_type === "contract" ? c.b : c.a).extraction.document_type;
  const pairs = dependentType === "invoice"
    ? [["buyer_inn", "contractor_inn"], ["buyer_inn", "customer_inn"]]
      : dependentType === "kfz_report"
      ? [["supplier_inn", "contractor_inn"], ["customer_inn", "customer_inn"]]
      : dependentType === "act"
        ? [["contractor_inn", "contractor_inn"], ["customer_inn", "customer_inn"]]
        : [["supplier_inn", "contractor_inn"], ["supplier_inn", "customer_inn"], ["buyer_inn", "contractor_inn"], ["buyer_inn", "customer_inn"]];
  let partySupport = false, contradiction = false;
  for (const [ka, kb] of pairs) {
    const aContract = c.a.extraction.document_type === "contract";
    const va = aContract ? c.b.values[ka] : c.a.values[ka], vb = aContract ? c.a.values[kb] : c.b.values[kb];
    if (usable(va) && usable(vb)) { if (normalizeIdentifier(valueOf(va)) === normalizeIdentifier(valueOf(vb))) { ev.push(evidence(va, aContract ? c.b.extraction.document_id : c.a.extraction.document_id, `fields.${ka}`, vb, aContract ? c.a.extraction.document_id : c.b.extraction.document_id, `fields.${kb}`, "party_inn", "ИНН стороны совпадает")); partySupport = true; } else contradiction = true; }
  }
  const namePairs: [string, string][] = dependentType === "invoice"
    ? [["buyer", "contractor"], ["buyer", "customer"]]
    : dependentType === "registry"
      ? [["organization", "contractor"], ["counterparty", "customer"]]
      : dependentType === "kfz_report"
        ? [["reporting_organization", "contractor"], ["customer", "customer"]]
        : dependentType === "addendum"
          ? [["party_1", "contractor"], ["party_1", "customer"], ["party_2", "contractor"], ["party_2", "customer"]]
          : dependentType === "act"
            ? [["contractor", "contractor"], ["customer", "customer"]]
            : [];
  for (const [dependentKey, contractKey] of namePairs) {
    const dependentValue = c.a.extraction.document_type === "contract" ? c.b.values[dependentKey] : c.a.values[dependentKey];
    const contractValue = c.a.extraction.document_type === "contract" ? c.a.values[contractKey] : c.b.values[contractKey];
    if (usable(dependentValue) && usable(contractValue) && normalizeText(valueOf(dependentValue)) === normalizeText(valueOf(contractValue))) {
      ev.push(evidence(dependentValue, c.a.extraction.document_type === "contract" ? c.b.extraction.document_id : c.a.extraction.document_id, `fields.${dependentKey}`, contractValue, doc.extraction.document_id, `fields.${contractKey}`, "party_name", "Наименование стороны точно совпадает с договором"));
      partySupport = true;
    }
  }
  if (contradiction && (dependentType !== "invoice" || !partySupport)) return [];
  return [mk(c, type, ev, partySupport ? .96 : .78, partySupport ? "Явная ссылка подтверждена совпадением ИНН стороны" : "Найдена явная ссылка на договор; независимого подтверждения недостаточно")];
}
