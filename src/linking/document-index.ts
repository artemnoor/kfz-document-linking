import type { Extraction } from "../contracts/input";
import type { IndexedDocument } from "./types";
import { valueOf } from "./normalization";

export function indexDocuments(documents: Extraction[]): IndexedDocument[] {
  return documents.map(extraction => {
    const values: Record<string, any> = { ...extraction.fields };
    extraction.indicators.forEach(i => { if (!(i.key in values)) values[i.key] = i.extracted; });
    const rows: { row: any; path: string; role: string; aliases: string[] }[] = [];
    const seen = new Map<string, number>();
    const add = (row: any, path: string, role: string) => {
      // Identical row IDs are authoritative within an extraction. A content key covers older
      // Structured Extraction results whose table copy has a different/missing row ID.
      const stableId = typeof row?.row_id === "string" && row.row_id ? `id:${row.row_id}` : "";
      const semantic = ["identifier", "description", "unit", "quantity", "actual_quantity", "amount"].map(k => String(valueOf(row?.[k]) ?? "").trim().toLocaleLowerCase("ru-RU")).join("\u001f");
      const key = stableId || `content:${semantic}`;
      const prior = seen.get(key);
      if (prior !== undefined) { rows[prior].aliases.push(path); return; }
      seen.set(key, rows.length); rows.push({ row, path, role, aliases: [path] });
    };
    const primaryKey = extraction.document_type === "contract" ? "payment_schedule" : extraction.document_type === "addendum" ? "changes" : "line_items";
    const primary = (extraction as any)[primaryKey];
    if (Array.isArray(primary)) primary.forEach((row: any, i: number) => add(row, `${primaryKey}[${i}]`, primaryKey));
    extraction.tables.forEach((table: any, ti: number) => {
      const role = String(table.role || "unknown").toLocaleLowerCase("ru-RU");
      table.rows.forEach((row: any, ri: number) => add(row, `tables[${ti}].rows[${ri}]`, role));
    });
    return { extraction, values, rows };
  });
}
