import { Hono } from "hono";
import { linkDocuments } from "../src/linking/link-resolver";
import { linkingOutputSchema } from "../src/contracts/output";
type Env = { DB: D1Database; ASSETS: Fetcher; POLZA_API_KEY?: string; LLM_ENABLED?: string; LLM_MODEL?: string; LLM_MAX_CALLS_PER_RUN?: string; LLM_TIMEOUT_MS?: string };
const app = new Hono<{ Bindings: Env }>();
app.get("/api/health", c => c.json({ status: "ok", service: "kfz-document-linking", contract_version: "1.0.0" }));
app.get("/api/demo", async c => {
  const names = ["act-2026-0424.json", "addendum-2026-04.json", "contract-2026-0315.json", "invoice-2026-0408.json", "kfz-2026-q1.json", "registry-2026-04.json", "receipt-unknown-1.json", "contract-ambiguous-a.json", "contract-ambiguous-b.json", "act-ambiguous-1.json"];
  try {
    const documents = await Promise.all(names.map(async name => {
      const response = await c.env.ASSETS.fetch(new Request(new URL(`/demo/${name}`, c.req.url)));
      if (!response.ok) throw new Error(`Demo fixture unavailable: ${name}`);
      return response.json();
    }));
    return c.json({ documents });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Не удалось загрузить демонстрацию" }, 503); }
});
app.post("/api/linking-runs", async c => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "Некорректный JSON тела запроса" }, 400); }
  try {
    const result = await linkDocuments(body.documents ?? body, { llm: { enabled: c.env.LLM_ENABLED === "true" && !!c.env.POLZA_API_KEY, apiKey: c.env.POLZA_API_KEY, model: c.env.LLM_MODEL ?? "deepseek/deepseek-v4-flash", maxCalls: Number(c.env.LLM_MAX_CALLS_PER_RUN ?? 8), timeoutMs: Number(c.env.LLM_TIMEOUT_MS ?? 12000) } });
    const checked = linkingOutputSchema.safeParse(result); if (!checked.success) return c.json({ error: "Ошибка внутреннего выходного контракта", diagnostics: checked.error.issues }, 500);
    if (c.env.DB) {
      await c.env.DB.prepare("INSERT INTO linking_runs (id, contract_version, created_at, input_documents_json, result_json) VALUES (?, ?, ?, ?, ?)").bind(result.linking_run_id, result.contract_version, result.created_at, JSON.stringify(result.input_documents), JSON.stringify(result)).run();
      for (const link of result.links) await c.env.DB.prepare("INSERT INTO links (id, run_id, source_document_id, target_document_id, relationship_type, status, confidence, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(link.link_id, result.linking_run_id, link.source_document_id, link.target_document_id, link.relationship_type, link.status, link.confidence, JSON.stringify(link)).run();
    }
    return c.json(result, 201);
  } catch (error: any) { return c.json({ error: error.message ?? "Не удалось связать документы", diagnostics: error.diagnostics ?? [] }, error.status ?? 500); }
});
app.get("/api/linking-runs/:id", async c => {
  if (!c.env.DB) return c.json({ error: "Хранилище недоступно" }, 503);
  const row: any = await c.env.DB.prepare("SELECT result_json FROM linking_runs WHERE id = ?").bind(c.req.param("id")).first();
  return row ? c.json(JSON.parse(row.result_json)) : c.json({ error: "Запуск не найден" }, 404);
});
app.patch("/api/linking-runs/:runId/links/:linkId", async c => {
  if (!c.env.DB) return c.json({ error: "Хранилище недоступно" }, 503);
  const body: any = await c.req.json().catch(() => null);
  if (!body || !["confirmed", "rejected"].includes(body.status)) return c.json({ error: "status должен быть confirmed или rejected" }, 400);
  const row: any = await c.env.DB.prepare("SELECT result_json FROM linking_runs WHERE id = ?").bind(c.req.param("runId")).first();
  if (!row) return c.json({ error: "Запуск не найден" }, 404);
  const result = JSON.parse(row.result_json), link = result.links.find((item: any) => item.link_id === c.req.param("linkId"));
  if (!link) return c.json({ error: "Связь не найдена" }, 404);
  link.status = body.status; link.verification_status = body.status === "confirmed" ? "human_confirmed" : "human_rejected";
  result.review_required = result.review_required.filter((item: any) => item.link_id !== link.link_id);
  await c.env.DB.prepare("UPDATE linking_runs SET result_json = ? WHERE id = ?").bind(JSON.stringify(result), result.linking_run_id).run();
  await c.env.DB.prepare("UPDATE links SET status = ?, payload_json = ? WHERE id = ? AND run_id = ?").bind(link.status, JSON.stringify(link), link.link_id, result.linking_run_id).run();
  return c.json(result);
});
export default app;
