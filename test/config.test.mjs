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
