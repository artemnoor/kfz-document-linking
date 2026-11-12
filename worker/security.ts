import type { Context, MiddlewareHandler } from "hono";

export type SecurityEnv = { DB?: D1Database; ASSETS?: Fetcher; API_BEARER_TOKEN?: string; POLZA_API_KEY?: string; LLM_ENABLED?: string; LLM_MAX_CALLS_PER_RUN?: string; LLM_TIMEOUT_MS?: string; LLM_MAX_INPUT_TOKENS?: string; LLM_MAX_RUN_MS?: string };
function equal(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export const requireApiToken: MiddlewareHandler<{ Bindings: SecurityEnv }> = async (c, next) => {
  const expected = c.env.API_BEARER_TOKEN;
  if (!expected) return c.json({ error: "Защищённый API не настроен: задайте API_BEARER_TOKEN" }, 503);
  const header = c.req.header("Authorization") ?? "", token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !equal(token, expected)) return c.json({ error: "Требуется авторизация" }, 401);
  await next();
};
export async function enforceRateLimit(c: Context<any>, action: "run" | "read"): Promise<Response | null> {
  if (!c.env.DB) return null;
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0].trim() ?? "unknown";
  const bucket: any = await c.env.DB.prepare("INSERT INTO api_rate_limits (bucket_key, window_started, request_count) VALUES (?, ?, 1) ON CONFLICT(bucket_key) DO UPDATE SET request_count = CASE WHEN excluded.window_started - api_rate_limits.window_started >= 600 THEN 1 ELSE api_rate_limits.request_count + 1 END, window_started = CASE WHEN excluded.window_started - api_rate_limits.window_started >= 600 THEN excluded.window_started ELSE api_rate_limits.window_started END RETURNING request_count").bind(`${action}:${ip}`, Math.floor(Date.now() / 1000)).first();
  const limit = action === "run" ? 20 : 120;
  return (bucket?.request_count ?? 0) > limit ? c.json({ error: "Слишком много запросов; повторите позже" }, 429) : null;
}
export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
