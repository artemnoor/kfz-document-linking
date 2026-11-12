import type { AnalysisProgressState, LinkingResult, Link } from "../src/linking/types";

export async function readAnalysisProgress(db: D1Database, payloadHash: string): Promise<AnalysisProgressState | undefined> {
  const row = await db.prepare("SELECT state_json FROM analysis_progress WHERE payload_hash = ?").bind(payloadHash).first<{ state_json: string }>();
  if (!row) return undefined;
  try { const state = JSON.parse(row.state_json) as AnalysisProgressState; return (state.version === 1 || state.version === 2) && Array.isArray(state.completed_fragments) ? state : undefined; } catch { return undefined; }
}
export async function saveAnalysisProgress(db: D1Database, payloadHash: string, state: AnalysisProgressState) {
  await db.prepare("INSERT INTO analysis_progress (payload_hash, updated_at, state_json) VALUES (?, ?, ?) ON CONFLICT(payload_hash) DO UPDATE SET updated_at = excluded.updated_at, state_json = excluded.state_json").bind(payloadHash, new Date().toISOString(), JSON.stringify(state)).run();
}

export async function findRunByIdempotency(db: D1Database, key: string) {
  return db.prepare("SELECT payload_hash, result_json FROM linking_runs WHERE idempotency_key = ?").bind(key).first<{ payload_hash: string; result_json: string }>();
}
export async function saveRun(db: D1Database, result: LinkingResult, key: string, payloadHash: string) {
  const statements = [db.prepare("INSERT INTO linking_runs (id, contract_version, created_at, input_documents_json, result_json, idempotency_key, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(result.linking_run_id, result.contract_version, result.created_at, JSON.stringify(result.input_documents), JSON.stringify(result), key, payloadHash), ...result.links.map(link => db.prepare("INSERT INTO links (id, run_id, source_document_id, target_document_id, relationship_type, status, confidence, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(link.link_id, result.linking_run_id, link.source_document_id, link.target_document_id, link.relationship_type, link.status, link.confidence, JSON.stringify(link))), db.prepare("DELETE FROM analysis_progress WHERE payload_hash = ?").bind(payloadHash)];
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

export type AnalysisJobRow = { id: string; status: "queued" | "running" | "retrying" | "completed" | "failed"; idempotency_key: string; payload_hash: string; payload_chunk_count: number; progress_json: string; attempts: number; lease_expires_at_ms: number | null; last_error: string | null; run_id: string | null; result_json: string | null; created_at: string; updated_at: string };
export async function findJobByIdempotency(db: D1Database, key: string) {
  return db.prepare("SELECT id, status, payload_hash FROM analysis_jobs WHERE idempotency_key = ?").bind(key).first<{ id: string; status: AnalysisJobRow["status"]; payload_hash: string }>();
}
export async function readJob(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").bind(id).first<AnalysisJobRow>();
}
export async function createJob(db: D1Database, args: { id: string; key: string; payloadHash: string; payload: string; now: string }) {
  const chunks: string[] = [];
  // Fixed-size character chunks stay well below D1's per-value limit even for UTF-8 input.
  for (let offset = 0; offset < args.payload.length; offset += 100_000) chunks.push(args.payload.slice(offset, offset + 100_000));
  const statements = [db.prepare("INSERT INTO analysis_jobs (id, created_at, updated_at, status, idempotency_key, payload_hash, payload_chunk_count, progress_json) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)").bind(args.id, args.now, args.now, args.key, args.payloadHash, chunks.length, JSON.stringify({ version: 2, started_at: args.now, fragment_budget_tokens: 0, completed_fragments: [], calls: 0, input_tokens: 0, output_tokens: 0, cost_amount: 0, has_cost: false }))];
  chunks.forEach((chunk, index) => statements.push(db.prepare("INSERT INTO analysis_job_payload_chunks (job_id, chunk_index, payload_text) VALUES (?, ?, ?)").bind(args.id, index, chunk)));
  await db.batch(statements);
}
export async function readJobPayload(db: D1Database, job: AnalysisJobRow): Promise<string> {
  const rows = await db.prepare("SELECT payload_text FROM analysis_job_payload_chunks WHERE job_id = ? ORDER BY chunk_index").bind(job.id).all<{ payload_text: string }>();
  if (rows.results.length !== job.payload_chunk_count) throw new Error("В сохранённом задании отсутствуют части исходного пакета");
  return rows.results.map(row => row.payload_text).join("");
}
export async function claimJob(db: D1Database, id: string, now: number, leaseMs: number): Promise<boolean> {
  const result = await db.prepare("UPDATE analysis_jobs SET status = 'running', attempts = attempts + 1, lease_expires_at_ms = ?, updated_at = ?, last_error = NULL WHERE id = ? AND status IN ('queued', 'retrying', 'running') AND (status != 'running' OR lease_expires_at_ms IS NULL OR lease_expires_at_ms < ?)").bind(now + leaseMs, new Date(now).toISOString(), id, now).run();
  return result.meta.changes === 1;
}
export async function saveJobProgress(db: D1Database, id: string, state: AnalysisProgressState, leaseUntil: number) {
  await db.prepare("UPDATE analysis_jobs SET progress_json = ?, updated_at = ?, lease_expires_at_ms = ? WHERE id = ? AND status = 'running'").bind(JSON.stringify(state), new Date().toISOString(), leaseUntil, id).run();
}
export async function queueJobAgain(db: D1Database, id: string) {
  await db.prepare("UPDATE analysis_jobs SET status = 'queued', lease_expires_at_ms = NULL, updated_at = ? WHERE id = ? AND status = 'running'").bind(new Date().toISOString(), id).run();
}
export async function completeJob(db: D1Database, id: string, runId: string, result: LinkingResult) {
  const now = new Date().toISOString();
  await db.prepare("UPDATE analysis_jobs SET status = 'completed', run_id = ?, result_json = ?, completed_at = ?, updated_at = ?, lease_expires_at_ms = NULL, last_error = NULL WHERE id = ?").bind(runId, JSON.stringify(result), now, now, id).run();
}
export async function failJob(db: D1Database, id: string, error: string, retrying = false) {
  await db.prepare("UPDATE analysis_jobs SET status = ?, last_error = ?, updated_at = ?, lease_expires_at_ms = NULL WHERE id = ? AND status != 'completed'").bind(retrying ? "retrying" : "failed", error.slice(0, 2000), new Date().toISOString(), id).run();
}
