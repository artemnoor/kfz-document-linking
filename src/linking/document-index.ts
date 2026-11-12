import type { Extraction } from "../contracts/input";
import type { IndexedDocument } from "./types";
export function indexDocuments(documents: Extraction[]): IndexedDocument[] {
  return documents.map(extraction => {
    const values: Record<string, any> = { ...extraction.fields };
    extraction.indicators.forEach(i => { if (!(i.key in values)) values[i.key] = i.extracted; });
    const rows: { row: any; path: string }[] = [];
    for (const [key, list] of Object.entries(extraction)) if (["line_items", "payment_schedule", "changes"].includes(key) && Array.isArray(list)) list.forEach((row, index) => rows.push({ row, path: `${key}[${index}]` }));
    extraction.tables.forEach((table, ti) => table.rows.forEach((row, ri) => rows.push({ row, path: `tables[${ti}].rows[${ri}]` })));
    return { extraction, values, rows };
  });
}
