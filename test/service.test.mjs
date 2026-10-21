import test from "node:test";
import assert from "node:assert/strict";
import { CheckerService } from "../src/service.mjs";

function result(status, latencyMs = null) {
  return { id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", status, latencyMs, pingLatencyMs: 20, checkedAt: new Date().toISOString(), message: status };
}

function alertService(sequence, sent, threshold = 3) {
  let index = 0;
  const store = { points: () => [], append: async () => {} };
  return new CheckerService({
    providers: [{ id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", groupName: null }],
    store,
    checkAll: async () => [result(sequence[index++])],
    intervalMs: 120_000,
    concurrency: 1,
    timeoutMs: 45_000,
    degradedMs: 10_000,
    alertConsecutiveFailures: threshold,
    alertNotifier: { enabled: true, send: async (mail) => sent.push(mail) }
  });
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

test("service sends one failure alert at the threshold and one recovery alert", async () => {
  const sent = [];
  const service = alertService(["error", "failed", "validation_failed", "degraded", "error", "error", "error"], sent);

  await service.run();
  await service.run();
  assert.equal(sent.length, 0);
  await service.run();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /连续检测失败/);
  assert.match(sent[0].text, /连续失败次数: 3/);

  await service.run();
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /已恢复/);

  await service.run();
  await service.run();
  await service.run();
  assert.equal(sent.length, 3);
  assert.match(sent[2].subject, /连续检测失败/);
});

test("degraded results do not count as failures", async () => {
  const sent = [];
  const service = alertService(["degraded", "degraded", "degraded"], sent);
  await service.run();
  await service.run();
  await service.run();
  assert.equal(sent.length, 0);
});

test("service summarizes a requested history window", () => {
  const points = [
    { ...result("failed", 500), checkedAt: "2026-08-15T23:00:00.000Z" },
    { ...result("operational", 1000), checkedAt: "2026-08-16T01:00:00.000Z" },
    { ...result("degraded", 11_000), checkedAt: "2026-08-16T02:00:00.000Z" },
    { ...result("error", null), checkedAt: "2026-08-16T03:00:00.000Z" }
  ];
  const service = new CheckerService({
    providers: [{ id: "one", name: "One", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", groupName: null }],
    store: { points: () => points, append: async () => {} },
    checkAll: async () => [],
    intervalMs: 60_000,
    concurrency: 1,
    timeoutMs: 45_000,
    degradedMs: 10_000,
    now: () => new Date("2026-08-16T04:00:00.000Z")
  });

  const summary = service.historySummary({ hours: 3, trendPoints: 2 });
  assert.equal(summary.providers[0].totalChecks, 3);
  assert.equal(summary.providers[0].failedChecks, 1);
  assert.equal(summary.providers[0].successRate, 66.67);
  assert.equal(summary.providers[0].avgLatencyMs, 6000);
  assert.equal(summary.providers[0].maxLatencyMs, 11_000);
  assert.deepEqual(summary.providers[0].trend, ["degraded", "error"]);
});

test("service only checks providers whose own interval elapsed", async () => {
  let nowMs = Date.parse("2026-08-16T04:00:00.000Z");
  const checked = [];
  const points = [];
  const service = new CheckerService({
    providers: [
      { id: "text", name: "Text", type: "openai", endpoint: "https://example.com/v1/responses", model: "gpt", groupName: null },
      { id: "image", name: "Image", type: "openai", endpoint: "https://example.com/v1/images/generations", model: "gpt-image-2", groupName: null, kind: "image", intervalMs: 3_600_000 }
    ],
    store: { points: () => points, append: async (items) => points.push(...items) },
    checkAll: async (providers) => {
      checked.push(providers.map((provider) => provider.id).join(","));
      return providers.map((provider) => ({ ...result("operational", 500), id: provider.id, name: provider.name }));
    },
    intervalMs: 60_000,
    concurrency: 1,
    timeoutMs: 45_000,
    degradedMs: 10_000,
    now: () => new Date(nowMs)
  });

  await service.runDue();
  assert.deepEqual(checked, ["text,image"]);
  const initial = service.status();
  assert.equal(initial.providers[1].kind, "image");
  assert.equal(initial.providers[1].intervalLabel, "1 小时");
  assert.equal(initial.providers[0].intervalLabel, "1 分钟");
  assert.ok(initial.providers[1].nextCheckAt);

  nowMs += 60_000;
  await service.runDue();
  assert.deepEqual(checked, ["text,image", "text"]);

  nowMs += 3_540_000;
  await service.runDue();
  assert.deepEqual(checked, ["text,image", "text", "text,image"]);

  nowMs += 1_000;
  assert.deepEqual(await service.runDue(), []);

  // Manual trigger still refreshes every provider regardless of cadence.
  await service.run();
  assert.equal(checked.at(-1), "text,image");
});

test("service stores the latest image and keeps history free of binaries", async () => {
  const points = [];
  const saves = [];
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const imageMeta = { mimeType: "image/png", bytes: PNG.length, capturedAt: "2026-10-17T12:00:00.000Z" };
  const service = new CheckerService({
    providers: [{ id: "img", name: "Img", type: "openai", endpoint: "https://x/v1/images/generations", model: "gpt-image-2", groupName: null, kind: "image", intervalMs: 3_600_000 }],
    store: { points: () => points, append: async (items) => points.push(...items) },
    checkAll: async () => [{
      ...result("operational", 1000),
      id: "img",
      name: "Img",
      image: { bytes: PNG }
    }],
    imageStore: {
      meta: (id) => (id === "img" ? imageMeta : null),
      save: async (id, image) => { saves.push([id, image.bytes.length]); return imageMeta; }
    },
    intervalMs: 60_000,
    concurrency: 1,
    timeoutMs: 45_000,
    degradedMs: 10_000
  });

  await service.runDue();
  assert.deepEqual(saves, [["img", PNG.length]]);
  assert.equal(points.length, 1);
  assert.equal("image" in points[0], false);
  assert.deepEqual(service.status().providers[0].image, imageMeta);
});
