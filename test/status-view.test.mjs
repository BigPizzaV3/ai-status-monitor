import test from "node:test";
import assert from "node:assert/strict";
import { transformStatus } from "../src/status-view.mjs";

test("status view converts checker data for the bundled frontend", () => {
  const source = {
    providers: [{
      id: "one",
      name: "One",
      type: "openai",
      model: "gpt",
      latest: { status: "degraded", latencyMs: 10_001, pingLatencyMs: 20, checkedAt: "2026-08-13T00:00:00.000Z", message: "slow" },
      statistics: { successRate: 100, totalChecks: 2 },
      timeline: [
        { status: "degraded", latencyMs: 10_001, pingLatencyMs: 20, checkedAt: "2026-08-13T00:00:00.000Z", message: "slow" },
        { status: "operational", latencyMs: 500, pingLatencyMs: 20, checkedAt: "2026-08-12T23:58:00.000Z", message: "ok" }
      ]
    }],
    summary: { total: 1, degraded: 1 },
    metadata: { pollIntervalMs: 120_000, pollIntervalLabel: "2 分钟" }
  };

  const output = transformStatus(source);
  assert.equal(output.overall, "degraded");
  assert.equal(output.checkedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(output.components[0].description, "gpt · OpenAI 协议");
  assert.equal(output.components[0].points[0].at, "2026-08-12T23:58:00.000Z");
  assert.equal(output.incidents[0].componentName, "One");
});
