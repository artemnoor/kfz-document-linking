import { Hono } from "hono";
import { buildLinkingResult, linkDocuments } from "../src/linking/link-resolver";
import { analyzeDocumentSet, GEMMA_MODEL } from "../src/linking/llm-matcher";
import { linkingOutputSchema } from "../src/contracts/output";
import { validateInput } from "../src/contracts/input";
import type { LinkingResult } from "../src/linking/types";
import { enforceRateLimit, requireApiToken, sha256, type SecurityEnv } from "./security";
import { claimJob, completeJob, createJob, failJob, findJobByIdempotency, findRunByIdempotency, queueJobAgain, readAnalysisProgress, readJob, readJobPayload, readRun, readRunJson, saveAnalysisProgress, saveJobProgress, saveRun, updateDecision, type AnalysisJobRow } from "./storage";

type Env = SecurityEnv & { DB: D1Database; ASSETS: Fetcher; ANALYSIS_QUEUE?: Queue<{ job_id: string }>; LLM_MAX_INPUT_TOKENS?: string };
const app = new Hono<{ Bindings: Env }>();
const MAX_BODY_BYTES = 3 * 1024 * 1024;
app.get("/api/health", c => c.json({ status: "ok", service: "kfz-document-linking", contract_version: "1.2.0", llm: { provider: "Polza AI", model: GEMMA_MODEL, configured: c.env.LLM_ENABLED === "true" && !!c.env.POLZA_API_KEY } }));
app.use("/api/demo", requireApiToken);
app.get("/api/demo", async c => {
  const limited = await enforceRateLimit(c, "read"); if (limited) return limited;
  const names = ["act-2026-0424.json", "addendum-2026-04.json", "contract-2026-0315.json", "invoice-2026-0408.json", "kfz-2026-q1.json", "registry-2026-04.json", "receipt-unknown-1.json", "contract-ambiguous-a.json", "contract-ambiguous-b.json", "act-ambiguous-1.json"];
  try {
    const documents = await Promise.all(names.map(async name => {
      const response = await c.env.ASSETS.fetch(new Request(new URL(`/demo/${name}`, c.req.url)));
      if (!response.ok) throw new Error(`Demo fixture unavailable: ${name}`);
      return response.json();
    }));
    return c.json({ documents });
  } catch { return c.json({ error: "Не удалось загрузить демонстрационные данные" }, 503); }
});
app.use("/api/linking-runs", requireApiToken);
app.use("/api/linking-runs/*", requireApiToken);

async function requestJson(c: any): Promise<{ body?: any; error?: string }> {
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > MAX_BODY_BYTES) return { error: "Размер запроса превышает 3 МиБ" };
  const reader = c.req.raw.body?.getReader();
  if (!reader) return { error: "Пустое тело запроса" };
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength; if (total > MAX_BODY_BYTES) { await reader.cancel(); return { error: "Размер запроса превышает 3 МиБ" }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { body: JSON.parse(new TextDecoder().decode(bytes)) }; } catch { return { error: "Некорректный JSON тела запроса" }; }
}

app.post("/api/linking-runs", async c => {
  const limited = await enforceRateLimit(c, "run"); if (limited) return limited;
  if (!c.env.DB) return c.json({ error: "Хранилище недоступно" }, 503);
  const parsed = await requestJson(c); if (parsed.error) return c.json({ error: parsed.error }, parsed.error.includes("Размер") ? 413 : 400);
  const body = parsed.body, documents = body?.documents ?? body;
  if (!Array.isArray(documents) || documents.length > 50) return c.json({ error: "Ожидается массив не более чем из 50 документов" }, 422);
  const payloadHash = await sha256(JSON.stringify(body));
  const rawKey = c.req.header("Idempotency-Key");
  if (rawKey && (rawKey.length > 128 || !/^[\w.:-]+$/.test(rawKey))) return c.json({ error: "Некорректный Idempotency-Key" }, 400);
  const key = rawKey ? await sha256(rawKey) : payloadHash;
  const existing = await findRunByIdempotency(c.env.DB, key);
  if (existing) return existing.payload_hash === payloadHash ? c.json(JSON.parse(existing.result_json), 200) : c.json({ error: "Idempotency-Key уже использован для другого содержимого" }, 409);
  try {
    const maxCalls = Math.min(52, Math.max(0, Number(c.env.LLM_MAX_CALLS_PER_RUN ?? 52)));
    const timeoutMs = Math.min(120000, Math.max(1000, Number(c.env.LLM_TIMEOUT_MS ?? 90000)));
    const maxInputTokens = Math.min(230000, Math.max(1000, Number(c.env.LLM_MAX_INPUT_TOKENS ?? 180000)));
    const maxRunMs = Math.min(900000, Math.max(10000, Number(c.env.LLM_MAX_RUN_MS ?? 900000)));
    const resumeProgress = await readAnalysisProgress(c.env.DB, payloadHash);
    const promptResponse = await c.env.ASSETS.fetch(new Request(new URL("/prompts/document-linking-system.md", c.req.url)));
    if (!promptResponse.ok) return c.json({ error: "Не найдена системная инструкция prompts/document-linking-system.md" }, 503);
    const systemPrompt = await promptResponse.text();
    const result = await linkDocuments(documents, { llm: { enabled: c.env.LLM_ENABLED === "true", apiKey: c.env.POLZA_API_KEY, model: GEMMA_MODEL, maxCalls, timeoutMs, maxRunMs, maxInputTokens, systemPrompt, resumeProgress, onProgress: state => saveAnalysisProgress(c.env.DB, payloadHash, state) } });
    const checked = linkingOutputSchema.safeParse(result);
    if (!checked.success) return c.json({ error: "Ошибка внутреннего выходного контракта", diagnostics: checked.error.issues }, 500);
    try { await saveRun(c.env.DB, result, key, payloadHash); }
    catch (error) {
      const retry = await findRunByIdempotency(c.env.DB, key);
      if (retry?.payload_hash === payloadHash) return c.json(JSON.parse(retry.result_json), 200);
      throw error;
    }
    return c.json(result, 201);
  } catch (error: any) { const status = Number.isInteger(error.status) ? error.status : 500; return c.json({ error: String(error.message ?? "Не удалось обработать пакет документов"), ...(status === 422 ? { diagnostics: error.diagnostics ?? [] } : {}) }, status); }
});

app.use("/api/linking-jobs", requireApiToken);
app.use("/api/linking-jobs/*", requireApiToken);
app.post("/api/linking-jobs", async c => {
  const limited = await enforceRateLimit(c, "run"); if (limited) return limited;
  if (!c.env.DB || !c.env.ANALYSIS_QUEUE) return c.json({ error: "Фоновая очередь недоступна" }, 503);
  const parsed = await requestJson(c); if (parsed.error) return c.json({ error: parsed.error }, parsed.error.includes("Размер") ? 413 : 400);
  const body = parsed.body, documents = body?.documents ?? body;
  if (!Array.isArray(documents) || documents.length > 50) return c.json({ error: "Ожидается массив не более чем из 50 документов" }, 422);
  const checked = validateInput(documents); if (!checked.success) return c.json({ error: "Входные данные не соответствуют Structured Extraction 1.2.0", diagnostics: checked.diagnostics }, 422);
  const payload = JSON.stringify({ documents: checked.documents }), payloadHash = await sha256(payload), rawKey = c.req.header("Idempotency-Key");
  if (rawKey && (rawKey.length > 128 || !/^[\w.:-]+$/.test(rawKey))) return c.json({ error: "Некорректный Idempotency-Key" }, 400);
  const key = rawKey ? await sha256(rawKey) : payloadHash, existing = await findJobByIdempotency(c.env.DB, key);
  if (existing) return existing.payload_hash === payloadHash ? c.json({ job_id: existing.id, status: existing.status }, 200) : c.json({ error: "Idempotency-Key уже использован для другого содержимого" }, 409);
  const id = crypto.randomUUID();
  try {
    await createJob(c.env.DB, { id, key, payloadHash, payload, now: new Date().toISOString() });
    await c.env.ANALYSIS_QUEUE.send({ job_id: id });
    return c.json({ job_id: id, status: "queued", status_url: `/api/linking-jobs/${id}` }, 202);
  } catch (error: any) {
    const retry = await findJobByIdempotency(c.env.DB, key);
    if (retry?.payload_hash === payloadHash) { if (retry.status === "queued") await c.env.ANALYSIS_QUEUE.send({ job_id: retry.id }); return c.json({ job_id: retry.id, status: retry.status }, 200); }
    return c.json({ error: String(error?.message ?? "Не удалось создать фоновое задание") }, 503);
  }
});
app.get("/api/linking-jobs/:id", async c => {
  const limited = await enforceRateLimit(c, "read"); if (limited) return limited;
  if (!c.env.DB) return c.json({ error: "Хранилище недоступно" }, 503);
  const job = await readJob(c.env.DB, c.req.param("id")); if (!job) return c.json({ error: "Задание не найдено" }, 404);
  let progress: any = {}; try { progress = JSON.parse(job.progress_json); } catch { /* diagnostics below */ }
  return c.json({ job_id: job.id, status: job.status, phase: progress.phase ?? (job.status === "queued" ? "queued" : job.status), progress: { completed_fragments: progress.completed_fragments?.length ?? 0, total_fragments: progress.total_fragments ?? null, model_calls: progress.calls ?? 0, input_tokens: progress.input_tokens ?? 0, output_tokens: progress.output_tokens ?? 0, cost_amount: progress.has_cost ? progress.cost_amount : null, cost_currency: progress.cost_currency ?? null, context_rounds: progress.context_rounds ?? 0 }, model: GEMMA_MODEL, provider: "Polza AI", attempts: job.attempts, last_error: job.last_error, run_id: job.run_id, result: job.status === "completed" ? JSON.parse(job.result_json ?? "null") : undefined, created_at: job.created_at, updated_at: job.updated_at });
});
app.post("/api/linking-jobs/:id/resume", async c => {
  const limited = await enforceRateLimit(c, "run"); if (limited) return limited;
  if (!c.env.DB || !c.env.ANALYSIS_QUEUE) return c.json({ error: "Фоновая очередь недоступна" }, 503);
  const job = await readJob(c.env.DB, c.req.param("id")); if (!job) return c.json({ error: "Задание не найдено" }, 404);
  if (job.status === "completed" || job.status === "queued" || job.status === "running" || job.status === "retrying") return c.json({ job_id: job.id, status: job.status }, 200);
  await c.env.DB.prepare("UPDATE analysis_jobs SET status = 'queued', last_error = NULL, lease_expires_at_ms = NULL, updated_at = ? WHERE id = ? AND status = 'failed'").bind(new Date().toISOString(), job.id).run();
  await c.env.ANALYSIS_QUEUE.send({ job_id: job.id });
  return c.json({ job_id: job.id, status: "queued" }, 202);
});

async function consumeAnalysisQueue(batch: MessageBatch<{ job_id: string }>, env: Env) {
  for (const message of batch.messages) {
    const id = message.body?.job_id;
    if (typeof id !== "string") { message.ack(); continue; }
    try {
      const job = await readJob(env.DB, id); if (!job || job.status === "completed" || job.status === "failed") { message.ack(); continue; }
      const leaseMs = 240_000;
      if (!await claimJob(env.DB, id, Date.now(), leaseMs)) { message.retry({ delaySeconds: 30 }); continue; }
      const internalKey = `job:${id}`, recovered = await findRunByIdempotency(env.DB, internalKey);
      if (recovered?.payload_hash === job.payload_hash) {
        const result = JSON.parse(recovered.result_json) as LinkingResult;
        await completeJob(env.DB, id, result.linking_run_id, result); message.ack(); continue;
      }
      const raw = JSON.parse(await readJobPayload(env.DB, job)), checked = validateInput(raw.documents);
      if (!checked.success) throw Object.assign(new Error("Сохранённый пакет не прошёл повторную проверку контракта"), { status: 422, diagnostics: checked.diagnostics });
      const promptResponse = await env.ASSETS.fetch(new Request("https://assets/prompts/document-linking-system.md"));
      if (!promptResponse.ok) throw Object.assign(new Error("Не найдена системная инструкция document-linking-system.md"), { status: 503 });
      let resumeProgress: any; try { resumeProgress = JSON.parse(job.progress_json); } catch { resumeProgress = undefined; }
      const maxCalls = Math.min(52, Math.max(1, Number(env.LLM_MAX_CALLS_PER_RUN ?? 52))), timeoutMs = Math.min(120000, Math.max(1000, Number(env.LLM_TIMEOUT_MS ?? 90000)));
      const analysis = await analyzeDocumentSet(checked.documents, { apiKey: env.POLZA_API_KEY ?? "", model: GEMMA_MODEL, timeoutMs, maxRunMs: Math.min(900000, Math.max(10000, Number(env.LLM_MAX_RUN_MS ?? 900000))), maxCalls, maxInputTokens: Math.min(230000, Math.max(1000, Number(env.LLM_MAX_INPUT_TOKENS ?? 180000))), systemPrompt: await promptResponse.text(), resumeProgress, maxModelCallsPerInvocation: 1, onProgress: state => saveJobProgress(env.DB, id, state, Date.now() + leaseMs) });
      if (!analysis.complete) {
        await queueJobAgain(env.DB, id);
        // analyzeDocumentSet checkpoints state through onProgress; reload it for the next explicit queue message.
        await env.ANALYSIS_QUEUE!.send({ job_id: id }); message.ack(); continue;
      }
      const result = buildLinkingResult(checked.documents, analysis);
      const output = linkingOutputSchema.safeParse(result); if (!output.success) throw Object.assign(new Error("Ошибка внутреннего выходного контракта"), { status: 500 });
      try { await saveRun(env.DB, result, internalKey, job.payload_hash); }
      catch (error) { const prior = await findRunByIdempotency(env.DB, internalKey); if (prior?.payload_hash !== job.payload_hash) throw error; }
      await completeJob(env.DB, id, result.linking_run_id, result); message.ack();
    } catch (error: any) {
      const status = Number(error?.status ?? 500), retryable = status === 402 || status === 429 || status >= 500 || status === 0;
      await failJob(env.DB, id, String(error?.message ?? "Ошибка фонового анализа"), retryable);
      if (retryable && message.attempts < 5) message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.max(0, message.attempts - 1)) }); else message.ack();
    }
  }
}
async function consumeDeadLetter(batch: MessageBatch<{ job_id: string }>, env: Env) {
  for (const message of batch.messages) { if (message.body?.job_id) await failJob(env.DB, message.body.job_id, "Исчерпаны повторные попытки Cloudflare Queue", false); message.ack(); }
}
app.get("/api/linking-runs/:id", async c => {
  const limited = await enforceRateLimit(c, "read"); if (limited) return limited;
  if (!c.env.DB) return c.json({ error: "Хранилище недоступно" }, 503);
  const result = await readRun(c.env.DB, c.req.param("id"));
  return result ? c.json(result) : c.json({ error: "Запуск не найден или повреждён" }, 404);
});
app.patch("/api/linking-runs/:runId/links/:linkId", async c => {
  const limited = await enforceRateLimit(c, "read"); if (limited) return limited;
  if (!c.env.DB) return c.json({ error: "Хранилище недоступно" }, 503);
  const parsed = await requestJson(c); if (parsed.error) return c.json({ error: parsed.error }, parsed.error.includes("Размер") ? 413 : 400);
  const body = parsed.body;
  if (!body || !["confirmed", "rejected"].includes(body.status)) return c.json({ error: "status должен быть confirmed или rejected" }, 400);
  const oldJson = await readRunJson(c.env.DB, c.req.param("runId")); if (!oldJson) return c.json({ error: "Запуск не найден" }, 404);
  let result: LinkingResult; try { result = JSON.parse(oldJson) as LinkingResult; } catch { return c.json({ error: "Результат запуска повреждён" }, 503); }
  const link = result.links.find(item => item.link_id === c.req.param("linkId")); if (!link) return c.json({ error: "Связь не найдена" }, 404);
  if (link.verification_status !== "not_reviewed" && link.status !== body.status) return c.json({ error: "Решение уже сохранено и не может быть перезаписано" }, 409);
  link.status = body.status; link.verification_status = body.status === "confirmed" ? "human_confirmed" : "human_rejected";
  result.review_required = result.review_required.filter(item => item.link_id !== link.link_id);
  try { if (!await updateDecision(c.env.DB, oldJson, result, link)) return c.json({ error: "Результат изменён параллельным запросом; перечитайте его" }, 409); } catch { return c.json({ error: "Не удалось атомарно сохранить решение" }, 503); }
  return c.json(result);
});
export default {
  fetch: (request: Request, env: Env, ctx?: ExecutionContext) => app.fetch(request, env, ctx as ExecutionContext),
  async queue(batch: MessageBatch<{ job_id: string }>, env: Env) {
    if (batch.queue.endsWith("dead-letter")) await consumeDeadLetter(batch, env);
    else await consumeAnalysisQueue(batch, env);
  },
};
