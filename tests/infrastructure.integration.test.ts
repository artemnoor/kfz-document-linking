import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createAnalysisQueue } from "../server/queue";
import { PostgresStorage } from "../server/storage";
import { runMigrations } from "../server/migrate";
import { recoverPendingJobs, startAnalysisWorker } from "../server/worker";
import { GEMMA_MODEL } from "../src/linking/llm-matcher";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
test("PostgreSQL persistence, exclusive claim and BullMQ retry/recovery", { skip: !databaseUrl || !redisUrl ? "Set DATABASE_URL and REDIS_URL to run infrastructure integration" : false }, async () => {
  const queueName = `document-linking-test-${randomUUID()}`;
  const pool = postgres(databaseUrl!, { max: 5 }), storage = new PostgresStorage(pool), queue = createAnalysisQueue(redisUrl!, queueName);
  const worker = startAnalysisWorker(redisUrl!, { storage, apiKey: "test-key", maxCalls: 52, maxInputTokens: 180_000, timeoutMs: 5000, maxRunMs: 90_000, systemPrompt: "Analyze the provided documents. Return JSON with links, unlinked_document_ids, analysis_summary and context_requests." }, queueName);
  const id = randomUUID(), lockId = randomUUID(), key = `integration:${id}`, payloadHash = `hash:${id}`;
  const documents = ["contract-2026-0315.json", "addendum-2026-04.json"].map(name => JSON.parse(readFileSync(`fixtures/upstream-structured-extraction-1.2.0/${name}`, "utf8")));
  let modelCalls = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelCalls++;
    if (modelCalls === 1) return new Response("temporary provider failure", { status: 503 });
    return new Response(JSON.stringify({ model: GEMMA_MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ links: [], unlinked_document_ids: documents.map(doc => doc.document_id), analysis_summary: "All documents reviewed.", context_requests: [] }) } }], usage: { prompt_tokens: 420, completion_tokens: 40, cost: 0.01, cost_currency: "RUB" } }), { status: 200 });
  };
  try {
    await runMigrations(pool);
    await storage.createJob({ id: lockId, key: `${key}:lock`, payloadHash: `${payloadHash}:lock`, payload: JSON.stringify({ documents }) });
    const claims = await Promise.all([storage.claimJob(lockId, 30_000), storage.claimJob(lockId, 30_000)]);
    assert.equal(claims.filter(Boolean).length, 1, "one job must not be claimed twice concurrently");
    await storage.createJob({ id, key, payloadHash, payload: JSON.stringify({ documents }) });
    assert.equal(await recoverPendingJobs(storage, queue), 2, "startup should re-enqueue persisted unfinished jobs");
    const deadline = Date.now() + 30_000; let saved = await storage.readJob(id);
    while (saved?.status !== "completed" && saved?.status !== "failed" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); saved = await storage.readJob(id); }
    assert.equal(saved?.status, "completed", saved?.last_error ?? "BullMQ job did not complete");
    assert.equal(saved?.attempts, 2, JSON.stringify(saved));
    assert.equal(saved?.progress_json?.calls, 2, JSON.stringify(saved));
    assert.equal(saved?.progress_json?.input_tokens, 420, JSON.stringify(saved));
    assert.equal(saved?.result_json?.processing_metadata.llm.model, GEMMA_MODEL);
    assert.equal(saved?.result_json?.processing_metadata.llm.calls, 2);
    assert.equal(modelCalls, 2, "one transient provider error should trigger one retry");
    const idem = await storage.findJobByIdempotency(key); assert.equal(idem?.id, id);
  } finally {
    globalThis.fetch = originalFetch;
    await worker.worker.close(); await worker.connection.quit(); await queue.close();
    await pool`DELETE FROM analysis_jobs WHERE id=${id} OR id=${lockId}`;
    await pool.end({ timeout: 5 });
  }
});
