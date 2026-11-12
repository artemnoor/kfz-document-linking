import type { Link } from "./types";
export function validateEvidence(link: Link): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!link.evidence.length) issues.push("Нет доказательств");
  for (const item of link.evidence) for (const side of [item.source, item.target]) {
    if (!side.document_id || !side.path || side.raw_value === null || !side.normalized_value) issues.push(`Неполная ссылка на поле ${side.path || "(путь отсутствует)"}`);
    const p = side.provenance as any;
    if (!p) issues.push(`Provenance отсутствует для ${side.document_id}:${side.path}`);
    else if (p.document_id !== side.document_id || typeof p.source_text !== "string" || !p.source_text.trim()) issues.push(`Некорректный provenance для ${side.document_id}:${side.path}`);
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)] };
}
