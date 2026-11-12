import type { IndexedDocument } from "./types";
import { normalizeIdentifier, usable, valueOf } from "./normalization";
export type Candidate = { a: IndexedDocument; b: IndexedDocument; kind: "document" | "row"; aRow?: any; bRow?: any; aPath?: string; bPath?: string };
export function generateCandidates(index: IndexedDocument[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < index.length; i++) for (let j = i + 1; j < index.length; j++) {
    const a = index[i], b = index[j], types = [a.extraction.document_type, b.extraction.document_type];
    if (types.some(t => t === "unknown")) continue;
    out.push({ a, b, kind: "document" });
    const pair = types.slice().sort().join(":");
    if (["act:registry", "act:kfz_report", "contract:kfz_report", "contract:registry"].includes(pair)) {
      const byIdentifier = new Map<string, typeof b.rows>();
      for (const row of b.rows) {
        const id = row.row.identifier;
        if (!usable(id)) continue;
        const key = normalizeIdentifier(valueOf(id));
        if (key) byIdentifier.set(key, [...(byIdentifier.get(key) ?? []), row]);
      }
      for (const row of a.rows) {
        const id = row.row.identifier;
        if (!usable(id)) continue;
        const key = normalizeIdentifier(valueOf(id));
        for (const match of byIdentifier.get(key) ?? []) out.push({ a, b, kind: "row", aRow: row.row, bRow: match.row, aPath: row.path, bPath: match.path });
      }
    }
  }
  return out;
}
