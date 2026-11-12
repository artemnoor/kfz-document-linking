import "dotenv/config";

export function readConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    databaseUrl: process.env.DATABASE_URL ?? "postgres://document_linking:document_linking@127.0.0.1:5432/document_linking",
    redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    apiToken: process.env.API_BEARER_TOKEN,
    polzaApiKey: process.env.POLZA_API_KEY ?? process.env.POLZA_AI_API_KEY,
    llmEnabled: process.env.LLM_ENABLED !== "false",
    maxCalls: Math.min(52, Math.max(1, Number(process.env.LLM_MAX_CALLS_PER_RUN ?? 52))),
    timeoutMs: Math.min(120_000, Math.max(1_000, Number(process.env.LLM_TIMEOUT_MS ?? 90_000))),
    maxInputTokens: Math.min(230_000, Math.max(1_000, Number(process.env.LLM_MAX_INPUT_TOKENS ?? 180_000))),
    maxRunMs: Math.min(900_000, Math.max(10_000, Number(process.env.LLM_MAX_RUN_MS ?? 900_000))),
  };
}
