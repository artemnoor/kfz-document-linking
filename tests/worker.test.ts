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
