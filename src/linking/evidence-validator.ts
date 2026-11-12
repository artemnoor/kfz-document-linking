import type { Extraction } from "../contracts/input";
import type { Link } from "./types";
import { normalizeText, valueOf } from "./normalization";

function atPath(doc: any, path: string): any {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  return parts.reduce((value, key) => value?.[key], doc);
}
export function validateEvidence(link: Link, documents?: Extraction[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!link.evidence.length) issues.push("Нет доказательств");
  const byId = new Map((documents ?? []).map(d => [d.document_id, d]));
  for (const item of link.evidence) for (const side of [item.source, item.target]) {
    if (!side.document_id || !side.path || side.raw_value === null || !side.normalized_value) issues.push(`Неполная ссылка на поле ${side.path || "(путь отсутствует)"}`);
    const p = side.provenance as any;
    if (!p) { issues.push(`Provenance отсутствует для ${side.document_id}:${side.path}`); continue; }
    if (p.document_id !== side.document_id) issues.push(`provenance относится к другому документу для ${side.document_id}:${side.path}`);
    if (p.source_available !== true) issues.push(`Исходный фрагмент недоступен или не подтверждён для ${side.document_id}:${side.path}`);
    if (typeof p.source_text !== "string" || !p.source_text.trim()) issues.push(`source_text отсутствует для ${side.document_id}:${side.path}`);
    const sourceText = normalizeText(p.source_text);
    const rawText = normalizeText(typeof side.raw_value === "object" ? JSON.stringify(side.raw_value) : side.raw_value);
    const entry = byId.get(side.document_id) ? atPath(byId.get(side.document_id), side.path) : undefined;
    if (entry && (JSON.stringify(entry.provenance ?? null) !== JSON.stringify(p) || JSON.stringify(valueOf(entry)) !== JSON.stringify(side.raw_value))) issues.push(`Доказательство не совпадает с исходным полем ${side.document_id}:${side.path}`);
    const sourceEquivalent = normalizeText(entry?.source_value ?? side.raw_value);
    if (sourceText && rawText && !sourceText.includes(rawText) && !rawText.includes(sourceText) && !sourceText.includes(sourceEquivalent)) issues.push(`source_text не подтверждает извлечённое значение для ${side.document_id}:${side.path}`);
    if (p.bbox && !(p.bbox.l <= p.bbox.r && p.bbox.t <= p.bbox.b)) issues.push(`Некорректный bbox для ${side.document_id}:${side.path}`);
    if (p.page_no !== undefined && p.page_no !== null && (!Number.isInteger(p.page_no) || p.page_no < 1)) issues.push(`Некорректный page_no для ${side.document_id}:${side.path}`);
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)] };
}
