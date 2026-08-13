import test from "node:test";
import assert from "node:assert/strict";
import { checkAll } from "../src/checker.mjs";

function checked(status, message) {
  return { status, message };
}

test("checkAll retries translated abort errors up to three attempts", async () => {
  let attempts = 0;
  const results = await checkAll([{ id: "one" }], {
    concurrency: 1,
    checkProvider: async () => {
      attempts += 1;
      return attempts < 3
        ? checked("error", "请求超时")
        : checked("operational", "验证通过");
    }
  });

  assert.equal(attempts, 3);
  assert.equal(results[0].status, "operational");
});

test("checkAll does not retry ordinary provider errors", async () => {
  let attempts = 0;
  const results = await checkAll([{ id: "one" }], {
    checkProvider: async () => {
      attempts += 1;
      return checked("error", "[401] Unauthorized");
    }
  });

  assert.equal(attempts, 1);
  assert.equal(results[0].status, "error");
});

test("checkAll excludes providers in maintenance", async () => {
  let attempts = 0;
  const results = await checkAll([{ id: "one", isMaintenance: true }], {
    checkProvider: async () => {
      attempts += 1;
      return checked("operational", "验证通过");
    }
  });

  assert.equal(attempts, 0);
  assert.deepEqual(results, []);
});
