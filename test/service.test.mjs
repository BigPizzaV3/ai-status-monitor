import test from "node:test";
import assert from "node:assert/strict";
import { CheckerService } from "../src/service.mjs";

function result(status, latencyMs = null) {
  return { id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", status, latencyMs, pingLatencyMs: 20, checkedAt: new Date().toISOString(), message: status };
}

test("service avoids overlapping checks and exposes compatible status", async () => {
  const points = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = { points: () => points, append: async (items) => points.push(...items) };
  const service = new CheckerService({ providers: [{ id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", groupName: null }], store, checkAll: async () => { await gate; return [result("degraded", 10_001)]; }, intervalMs: 120_000, concurrency: 1, timeoutMs: 45_000, degradedMs: 10_000 });
  const first = service.run();
  const second = service.run();
  assert.equal(first, second);
  release();
  await first;
  const status = service.status();
  assert.equal(status.providers[0].latest.status, "degraded");
  assert.equal(status.providers[0].statistics.successRate, 100);
  assert.equal(status.summary.degraded, 1);
  assert.equal(status.metadata.pollIntervalMs, 120_000);
  assert.equal(status.metadata.pollIntervalLabel, "2 分钟");
});

test("service keeps exactly 10000ms operational and marks only greater latency degraded", async () => {
  const points = [result("operational", 10_000), result("degraded", 10_001)];
  const store = { points: () => points, append: async () => {} };
  const service = new CheckerService({
    providers: [{ id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", groupName: null }],
    store,
    checkAll: async () => [],
    intervalMs: 120_000,
    concurrency: 1,
    timeoutMs: 45_000,
    degradedMs: 10_000
  });

  const status = service.status();
  assert.equal(status.providers[0].statistics.operationalCount, 1);
  assert.equal(status.providers[0].statistics.degradedCount, 1);
  assert.equal(status.providers[0].latest.latencyMs, 10_001);
});

test("service paginates history without replacing the current provider status", () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    ...result(index === 7 ? "degraded" : "operational", 500 + index),
    checkedAt: `2026-08-13T00:0${index}:00.000Z`
  }));
  const store = { points: () => points, append: async () => {} };
  const service = new CheckerService({
    providers: [{ id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", groupName: null }],
    store,
    checkAll: async () => [],
    intervalMs: 60_000,
    concurrency: 1,
    timeoutMs: 45_000,
    degradedMs: 10_000,
    apiHistoryPoints: 3
  });

  const middlePage = service.status({ historyPage: 1 });
  assert.equal(middlePage.providers[0].latest.checkedAt, "2026-08-13T00:07:00.000Z");
  assert.equal(middlePage.providers[0].latest.status, "degraded");
  assert.deepEqual(middlePage.providers[0].timeline.map((item) => item.checkedAt), [
    "2026-08-13T00:04:00.000Z",
    "2026-08-13T00:03:00.000Z",
    "2026-08-13T00:02:00.000Z"
  ]);
  assert.equal(middlePage.metadata.hasOlderHistory, true);
  assert.equal(middlePage.metadata.hasNewerHistory, true);

  const oldestPage = service.status({ historyPage: 2 });
  assert.deepEqual(oldestPage.providers[0].timeline.map((item) => item.checkedAt), [
    "2026-08-13T00:01:00.000Z",
    "2026-08-13T00:00:00.000Z"
  ]);
  assert.equal(oldestPage.metadata.hasOlderHistory, false);
  assert.equal(oldestPage.metadata.hasNewerHistory, true);
});
