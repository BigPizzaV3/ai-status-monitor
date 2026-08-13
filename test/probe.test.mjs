import test from "node:test";
import assert from "node:assert/strict";
import { createProbe, validateProbeResponse } from "../src/checker.mjs";

test("challenge mode uses the generated question and validates its answer", () => {
  const probe = createProbe({ checkMode: "challenge" }, () => ({ prompt: "question", expectedAnswer: "apple" }));
  assert.deepEqual(probe, { prompt: "question", expectedAnswer: "apple", mode: "challenge" });
  assert.equal(validateProbeResponse("apple", probe).valid, true);
  assert.equal(validateProbeResponse("banana", probe).valid, false);
});

test("simple mode defaults to hi and accepts any non-empty response", () => {
  const probe = createProbe({ checkMode: "simple" });
  assert.deepEqual(probe, { prompt: "hi", expectedAnswer: null, mode: "simple" });
  assert.equal(validateProbeResponse("hello", probe).valid, true);
  assert.deepEqual(validateProbeResponse("  ", probe), { valid: false, message: "回复为空" });
});

test("simple mode sends a configured prompt", () => {
  const probe = createProbe({ checkMode: "simple", simplePrompt: "ping" });
  assert.equal(probe.prompt, "ping");
});
