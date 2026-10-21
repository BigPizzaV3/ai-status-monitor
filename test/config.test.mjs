import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";

const provider = {
  id: "one",
  name: "One",
  type: "openai",
  endpoint: "https://example.com/v1/responses",
  model: "gpt",
  apiKey: "secret"
};

async function configFile(t, value) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-status-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "providers.json");
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

test("configuration defaults to challenge mode and hi prompt", async (t) => {
  const [loaded] = await loadConfig(await configFile(t, [provider]));
  assert.equal(loaded.checkMode, "challenge");
  assert.equal(loaded.simplePrompt, "hi");
});

test("configuration supports simple mode and custom prompt", async (t) => {
  const [loaded] = await loadConfig(await configFile(t, [{ ...provider, checkMode: "simple", simplePrompt: "ping" }]));
  assert.equal(loaded.checkMode, "simple");
  assert.equal(loaded.simplePrompt, "ping");
});

test("configuration rejects unsupported modes", async (t) => {
  await assert.rejects(
    loadConfig(await configFile(t, [{ ...provider, checkMode: "unknown" }])),
    /unsupported checkMode/
  );
});

test("configuration supports hourly image probes with image defaults", async (t) => {
  const [loaded] = await loadConfig(await configFile(t, [{
    ...provider,
    checkMode: "image",
    model: "gpt-image-2",
    endpoint: "https://example.com/v1/images/generations",
    intervalSeconds: 3600
  }]));
  assert.equal(loaded.checkMode, "image");
  assert.equal(loaded.kind, "image");
  assert.equal(loaded.intervalMs, 3_600_000);
  assert.equal(loaded.timeoutMs, 240_000);
  assert.equal(loaded.degradedMs, 120_000);
  assert.equal(loaded.imageSize, "1024x1024");
  assert.match(loaded.imagePrompt, /拉布拉多/);
});

test("configuration validates per-provider interval and image options", async (t) => {
  await assert.rejects(loadConfig(await configFile(t, [{ ...provider, intervalSeconds: 5 }])), /intervalSeconds/);
  await assert.rejects(loadConfig(await configFile(t, [{ ...provider, checkMode: "image", imageSize: "huge" }])), /invalid imageSize/);
  const [loaded] = await loadConfig(await configFile(t, [{ ...provider, intervalSeconds: 3600, degradedMs: 9000, timeoutMs: 60_000 }]));
  assert.equal(loaded.intervalMs, 3_600_000);
  assert.equal(loaded.degradedMs, 9000);
  assert.equal(loaded.timeoutMs, 60_000);
});
