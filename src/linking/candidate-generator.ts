import type { IndexedDocument } from "./types";
import { compareDescription, compareIdentifier, usable, valueOf } from "./normalization";
export type Candidate = { a: IndexedDocument; b: IndexedDocument; kind: "document" | "row"; aRow?: any; bRow?: any; aPath?: string; bPath?: string; aRole?: string; bRole?: string };

const rowPairs = new Set(["act:registry", "act:kfz_report", "kfz_report:registry", "contract:kfz_report", "contract:registry"]);
const rowRoleAllowed = (docType: string, role: string) => {
  if (docType === "contract") return role === "payment_schedule" || role === "line_items";
  if (docType === "addendum") return false;
  return role === "line_items";
};

export function generateCandidates(index: IndexedDocument[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < index.length; i++) for (let j = i + 1; j < index.length; j++) {
    const a = index[i], b = index[j], types = [a.extraction.document_type, b.extraction.document_type];
    if (types.includes("unknown")) continue;
    out.push({ a, b, kind: "document" });
    if (!rowPairs.has(types.slice().sort().join(":"))) continue;
    for (const ar of a.rows) for (const br of b.rows) {
      if (!rowRoleAllowed(types[0], ar.role) || !rowRoleAllowed(types[1], br.role)) continue;
      const ai = ar.row.identifier, bi = br.row.identifier, ad = ar.row.description, bd = br.row.description;
      const idMatch = usable(ai) && usable(bi) && compareIdentifier(valueOf(ai), valueOf(bi)) !== "none";
      const descMatch = usable(ad) && usable(bd) && compareDescription(valueOf(ad), valueOf(bd)).kind !== "none";
      if (idMatch || descMatch) out.push({ a, b, kind: "row", aRow: ar.row, bRow: br.row, aPath: ar.path, bPath: br.path, aRole: ar.role, bRole: br.role });
    }
  }
  return out;
}
