import { Hono } from "hono";
import { linkDocuments } from "../src/linking/link-resolver";
import { linkingOutputSchema } from "../src/contracts/output";
import type { LinkingResult } from "../src/linking/types";
import { enforceRateLimit, requireApiToken, sha256, type SecurityEnv } from "./security";
import { findRunByIdempotency, readRun, readRunJson, saveRun, updateDecision } from "./storage";

type Env = SecurityEnv & { DB: D1Database; ASSETS: Fetcher };
const app = new Hono<{ Bindings: Env }>();
const MAX_BODY_BYTES = 3 * 1024 * 1024;
app.get("/api/health", c => c.json({ status: "ok", service: "kfz-document-linking", contract_version: "1.0.0" }));
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
    const maxCalls = Math.min(8, Math.max(0, Number(c.env.LLM_MAX_CALLS_PER_RUN ?? 8)));
    const timeoutMs = Math.min(30000, Math.max(1000, Number(c.env.LLM_TIMEOUT_MS ?? 12000)));
    const result = await linkDocuments(documents, { llm: { enabled: c.env.LLM_ENABLED === "true" && !!c.env.POLZA_API_KEY, apiKey: c.env.POLZA_API_KEY, model: c.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash", maxCalls, timeoutMs } });
    const checked = linkingOutputSchema.safeParse(result);
    if (!checked.success) return c.json({ error: "Ошибка внутреннего выходного контракта", diagnostics: checked.error.issues }, 500);
    try { await saveRun(c.env.DB, result, key, payloadHash); }
    catch (error) {
      const retry = await findRunByIdempotency(c.env.DB, key);
      if (retry?.payload_hash === payloadHash) return c.json(JSON.parse(retry.result_json), 200);
      throw error;
    }
    return c.json(result, 201);
  } catch (error: any) { return c.json({ error: error.status === 422 ? error.message : "Не удалось обработать пакет документов", ...(error.status === 422 ? { diagnostics: error.diagnostics ?? [] } : {}) }, error.status ?? 500); }
});
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
export default app;
