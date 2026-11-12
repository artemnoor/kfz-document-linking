import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { validateInput } from "../src/contracts/input";
import { linkingOutputSchema } from "../src/contracts/output";
import { buildLinkingResult } from "../src/linking/link-resolver";
import { analyzeDocumentSet, GEMMA_MODEL } from "../src/linking/llm-matcher";
import type { AnalysisProgressState } from "../src/linking/types";
import { ANALYSIS_QUEUE_NAME, type AnalysisQueue } from "./queue";
import { PostgresStorage } from "./storage";

const LEASE_MS = 30_000;
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
function statusOf(error: any): number { return Number.isInteger(error?.status) ? error.status : 500; }
function retryable(error: any): boolean { const status = statusOf(error); return status === 0 || status >= 500; }

export async function recoverPendingJobs(storage: PostgresStorage, queue: AnalysisQueue): Promise<number> {
  const ids = await storage.listRecoverableJobIds();
  for (const id of ids) await queue.enqueue(id);
  return ids.length;
}

export async function processAnalysisJob(job: Job<{ job_id: string }>, deps: { storage: PostgresStorage; apiKey: string; maxCalls: number; maxInputTokens: number; timeoutMs: number; maxRunMs: number; systemPrompt?: string }) {
  const { storage } = deps, id = job.data.job_id;
  const jobRow = await storage.readJob(id);
  if (!jobRow || jobRow.status === "completed") return { skipped: true };
  const claimed = await storage.claimJob(id, LEASE_MS);
  if (!claimed) {
    if (jobRow.status === "running" && (jobRow.lease_expires_at_ms ?? 0) > Date.now()) return { skipped: true, reason: "job_already_claimed" };
    throw new Error("Не удалось атомарно захватить задание; BullMQ повторит попытку");
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  heartbeat = setInterval(() => { void storage.heartbeatJob(id, LEASE_MS).catch(() => undefined); }, 5_000);
  try {
    const existingRun = await storage.findRunByIdempotency(`job:${id}`);
    if (existingRun?.payload_hash === jobRow.payload_hash) {
      await storage.completeJob(id, existingRun.result_json); return { run_id: existingRun.result_json.linking_run_id, recovered: true };
    }
    const raw = JSON.parse(await storage.readJobPayload(jobRow));
    const checked = validateInput(raw.documents);
    if (!checked.success) throw Object.assign(new Error("Сохранённый пакет не прошёл повторную проверку контракта"), { status: 422, diagnostics: checked.diagnostics });
    const systemPrompt = deps.systemPrompt ?? await readFile(resolve(process.cwd(), "prompts/document-linking-system.md"), "utf8");
    let progress: AnalysisProgressState = jobRow.progress_json;
    const attemptStarted = Date.now();
    while (true) {
      const remainingMs = deps.maxRunMs - (Date.now() - attemptStarted);
      if (remainingMs <= 0) throw Object.assign(new Error(`Фоновое задание превысило лимит выполнения ${deps.maxRunMs} мс`), { status: 504 });
      const analysis = await analyzeDocumentSet(checked.documents, {
        apiKey: deps.apiKey, model: GEMMA_MODEL, maxCalls: deps.maxCalls, timeoutMs: deps.timeoutMs,
        maxRunMs: remainingMs, maxInputTokens: deps.maxInputTokens, systemPrompt,
        resumeProgress: progress, maxModelCallsPerInvocation: 1,
        onProgress: async state => { progress = state; await storage.saveJobProgress(id, state, LEASE_MS); },
      });
      if (analysis.complete) {
        const result = buildLinkingResult(checked.documents, analysis);
        const valid = linkingOutputSchema.safeParse(result);
        if (!valid.success) throw Object.assign(new Error("Ошибка внутреннего выходного контракта"), { status: 500 });
        try { await storage.saveRun(result, `job:${id}`, jobRow.payload_hash); }
        catch (error) { const existing = await storage.findRunByIdempotency(`job:${id}`); if (existing?.payload_hash !== jobRow.payload_hash) throw error; }
        await storage.completeJob(id, result); return { run_id: result.linking_run_id, calls: analysis.calls };
      }
      const stored = await storage.readJob(id);
      if (!stored) throw new Error("Задание исчезло во время анализа");
      progress = stored.progress_json;
      await sleep(0);
    }
  } catch (error: any) {
    const shouldRetry = retryable(error) && job.attemptsMade + 1 < (job.opts.attempts ?? 5);
    await storage.failJob(id, String(error?.message ?? "Ошибка фонового анализа"), shouldRetry);
    throw error;
  } finally { if (heartbeat) clearInterval(heartbeat); }
}

export function startAnalysisWorker(redisUrl: string, deps: Parameters<typeof processAnalysisJob>[1], queueName = ANALYSIS_QUEUE_NAME) {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<{ job_id: string }>(queueName, job => processAnalysisJob(job, deps), {
    connection, concurrency: 1, lockDuration: 60_000, maxStalledCount: 5, stalledInterval: 15_000,
  });
  worker.on("failed", job => { if (job) console.error(`Analysis job failed (${job.id}); attempt ${job.attemptsMade}`); });
  worker.on("error", error => console.error("BullMQ worker error:", error.message));
  return { worker, connection };
}
