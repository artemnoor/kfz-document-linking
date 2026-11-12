export const POLZA_BASE_URL = "https://polza.ai/api/v1";
export const POLZA_MODEL = "google/gemma-4-26b-a4b-it";
export type PolzaJsonResponse<T = unknown> = { value: T; model: string; finishReason?: string; promptTokens: number; completionTokens: number; cost?: number; currency?: string };
function describeStatus(status: number): string {
  if (status === 402) return "Polza AI отклонил запрос из-за баланса или оплаты (HTTP 402)";
  if (status === 429) return "Polza AI ограничил частоту запросов (HTTP 429)";
  return `Polza AI вернул HTTP ${status}`;
}

export async function requestPolzaJson<T = unknown>(args: { apiKey: string; model: string; timeoutMs: number; maxTokens: number; systemPrompt: string; userContent: string }): Promise<PolzaJsonResponse<T>> {
  if (args.model !== POLZA_MODEL) throw Object.assign(new Error(`Разрешена только модель ${POLZA_MODEL}`), { status: 500 });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await fetch(`${POLZA_BASE_URL}/chat/completions`, {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: args.model, temperature: 0, max_tokens: args.maxTokens, response_format: { type: "json_object" }, messages: [{ role: "system", content: args.systemPrompt }, { role: "user", content: args.userContent }] }),
    });
    if (!response.ok) throw Object.assign(new Error(describeStatus(response.status)), { status: response.status === 402 || response.status === 429 ? 503 : 502 });
    const body: any = await response.json(), usage = body.usage ?? {};
    if (body.model && body.model !== POLZA_MODEL) throw Object.assign(new Error(`Polza ответил моделью ${body.model}, ожидалась только ${POLZA_MODEL}`), { status: 502 });
    let value: T;
    try { value = JSON.parse(body.choices?.[0]?.message?.content || "") as T; }
    catch { throw Object.assign(new Error("Gemma вернула невалидный JSON"), { status: 502 }); }
    const cost = typeof usage.cost === "number" ? usage.cost : typeof body.cost === "number" ? body.cost : undefined;
    return { value, model: body.model ?? args.model, finishReason: body.choices?.[0]?.finish_reason, promptTokens: Number(usage.prompt_tokens) || 0, completionTokens: Number(usage.completion_tokens) || 0, ...(cost !== undefined ? { cost } : {}), ...((usage.cost_currency ?? usage.currency ?? body.cost_currency ?? body.currency) ? { currency: usage.cost_currency ?? usage.currency ?? body.cost_currency ?? body.currency } : {}) };
  } catch (error: any) {
    if (error?.name === "AbortError") throw Object.assign(new Error(`Истекло время ожидания Polza (${args.timeoutMs} мс)`), { status: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}
