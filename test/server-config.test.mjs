import test from "node:test";
import assert from "node:assert/strict";
import { booleanEnv, stringEnv } from "../src/env.mjs";

test("boolean configuration defaults to disabled", () => {
  const name = "TEST_STATUS_BOOLEAN_UNSET";
  delete process.env[name];
  assert.equal(booleanEnv(name), false);
  assert.equal(booleanEnv(name, true), true);
});

test("boolean configuration accepts common values", () => {
  const name = "TEST_STATUS_BOOLEAN";
  for (const value of ["false", "0", "off", "no"]) {
    process.env[name] = value;
    assert.equal(booleanEnv(name), false);
  }
  for (const value of ["true", "1", "on", "yes"]) {
    process.env[name] = value;
    assert.equal(booleanEnv(name), true);
  }
  delete process.env[name];
});

test("string configuration trims, falls back and limits length", () => {
  const name = "TEST_STATUS_STRING";
  delete process.env[name];
  assert.equal(stringEnv(name, "default"), "default");
  process.env[name] = "  custom title  ";
  assert.equal(stringEnv(name, "default"), "custom title");
  assert.equal(stringEnv(name, "default", 6), "custom");
  delete process.env[name];
});
