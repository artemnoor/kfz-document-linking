import type { LinkingResult, Link } from "../src/linking/types";

export async function findRunByIdempotency(db: D1Database, key: string) {
  return db.prepare("SELECT payload_hash, result_json FROM linking_runs WHERE idempotency_key = ?").bind(key).first<{ payload_hash: string; result_json: string }>();
}
export async function saveRun(db: D1Database, result: LinkingResult, key: string, payloadHash: string) {
  const statements = [db.prepare("INSERT INTO linking_runs (id, contract_version, created_at, input_documents_json, result_json, idempotency_key, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(result.linking_run_id, result.contract_version, result.created_at, JSON.stringify(result.input_documents), JSON.stringify(result), key, payloadHash), ...result.links.map(link => db.prepare("INSERT INTO links (id, run_id, source_document_id, target_document_id, relationship_type, status, confidence, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(link.link_id, result.linking_run_id, link.source_document_id, link.target_document_id, link.relationship_type, link.status, link.confidence, JSON.stringify(link)))];
  await db.batch(statements);
}
export async function updateDecision(db: D1Database, oldJson: string, result: LinkingResult, link: Link): Promise<boolean> {
  const newJson = JSON.stringify(result);
  const results = await db.batch([
    db.prepare("UPDATE linking_runs SET result_json = ? WHERE id = ? AND result_json = ?").bind(newJson, result.linking_run_id, oldJson),
    db.prepare("UPDATE links SET status = ?, payload_json = ? WHERE id = ? AND run_id = ? AND EXISTS (SELECT 1 FROM linking_runs WHERE id = ? AND result_json = ?)").bind(link.status, JSON.stringify(link), link.link_id, result.linking_run_id, result.linking_run_id, newJson),
  ]);
  return results[0]?.meta?.changes === 1;
}
export async function readRunJson(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT result_json FROM linking_runs WHERE id = ?").bind(id).first<{ result_json: string }>();
  return row?.result_json ?? null;
}
export async function readRun(db: D1Database, id: string): Promise<LinkingResult | null> {
  const row = await db.prepare("SELECT result_json FROM linking_runs WHERE id = ?").bind(id).first<{ result_json: string }>();
  if (!row) return null;
  try { return JSON.parse(row.result_json) as LinkingResult; } catch { return null; }
}
