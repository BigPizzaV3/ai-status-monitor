import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HistoryStore } from "../src/store.mjs";

test("history store persists atomically, prunes old points and enforces private permissions", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-status-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "history.json");
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await fs.writeFile(file, JSON.stringify({ one: [{ id: "one", checkedAt: old }] }), { mode: 0o644 });

  const store = new HistoryStore(file, 1);
  await store.init();
  assert.deepEqual(store.points("one"), []);

  const current = { id: "one", checkedAt: new Date().toISOString(), status: "operational" };
  await store.append([current]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { one: [current] });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(`${file}.tmp`), { code: "ENOENT" });
});
