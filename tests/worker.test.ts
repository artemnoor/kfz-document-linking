import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../worker/index";

test("health endpoint stays public while result APIs fail closed without a token", async () => {
  const env: any = { ASSETS: { fetch: async () => new Response("{}") }, DB: undefined };
  const health = await app.fetch(new Request("http://localhost/api/health"), env);
  assert.equal(health.status, 200);
  const result = await app.fetch(new Request("http://localhost/api/linking-runs/id"), env);
  assert.equal(result.status, 503);
});

test("result API rejects missing or incorrect bearer credentials", async () => {
  const env: any = { ASSETS: { fetch: async () => new Response("{}") }, API_BEARER_TOKEN: "server-secret" };
  for (const authorization of [undefined, "Bearer wrong"]) {
    const request = new Request("http://localhost/api/linking-runs/id", { headers: authorization ? { Authorization: authorization } : {} });
    const response = await app.fetch(request, env);
    assert.equal(response.status, 401);
  }
  const demo = await app.fetch(new Request("http://localhost/api/demo"), env);
  assert.equal(demo.status, 401);
});

test("background job status exposes durable progress and the pinned model", async () => {
  const row = { id: "job-1", status: "running", progress_json: JSON.stringify({ version: 2, completed_fragments: [{}, {}], total_fragments: 5, calls: 3, input_tokens: 1200, output_tokens: 90, context_rounds: 1, has_cost: true, cost_amount: 0.04, cost_currency: "RUB", phase: "reading_documents" }), attempts: 2, last_error: null, run_id: null, result_json: null, created_at: "2026-11-13T10:00:00.000Z", updated_at: "2026-11-13T10:01:00.000Z" };
  const env: any = { API_BEARER_TOKEN: "server-secret", DB: { prepare(sql: string) { return { bind() { return { first: async () => sql.includes("api_rate_limits") ? { request_count: 1 } : row }; } }; } } };
  const response = await app.fetch(new Request("http://localhost/api/linking-jobs/job-1", { headers: { Authorization: "Bearer server-secret" } }), env);
  assert.equal(response.status, 200);
  const job: any = await response.json();
  assert.equal(job.phase, "reading_documents"); assert.equal(job.progress.completed_fragments, 2); assert.equal(job.progress.total_fragments, 5);
  assert.equal(job.progress.input_tokens, 1200); assert.equal(job.progress.output_tokens, 90); assert.equal(job.progress.cost_amount, 0.04);
  assert.equal(job.model, "google/gemma-4-26b-a4b-it"); assert.equal(job.provider, "Polza AI");
});
