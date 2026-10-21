import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImageStore, detectImageMime } from "../src/image-store.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

async function tempStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-status-images-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ImageStore({ directory, ...options });
  await store.init();
  return { store, directory };
}

test("detectImageMime recognises png and jpeg magic bytes", () => {
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(detectImageMime(JPEG), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("not an image")), null);
});

test("image store keeps only the latest image per provider", async (t) => {
  let clock = Date.parse("2026-10-17T12:00:00.000Z");
  const { store, directory } = await tempStore(t, { now: () => new Date(clock) });
  const first = await store.save("gpt-image", { bytes: PNG });
  assert.equal(first.mimeType, "image/png");
  assert.equal(first.bytes, PNG.length);
  assert.equal(store.meta("gpt-image").capturedAt, "2026-10-17T12:00:00.000Z");

  clock += 60_000;
  await store.save("gpt-image", { bytes: PNG });
  assert.equal(store.meta("gpt-image").capturedAt, "2026-10-17T12:01:00.000Z");
  assert.deepEqual(await fs.readdir(directory), ["gpt-image.png"]);

  const read = await store.read("gpt-image");
  assert.equal(read.mimeType, "image/png");
  assert.ok(read.bytes.equals(PNG));
});

test("image store restores existing files on init", async (t) => {
  const { store, directory } = await tempStore(t);
  await store.save("a", { bytes: JPEG });
  const restored = new ImageStore({ directory });
  assert.deepEqual(await restored.init(), ["a"]);
  assert.equal(restored.meta("a").mimeType, "image/jpeg");
});

test("image store rejects unsafe ids, unsupported payloads and oversized images", async (t) => {
  const { store, directory } = await tempStore(t);
  await assert.rejects(store.save("../evil", { bytes: PNG }), /Invalid image provider id/);
  await assert.rejects(store.save("a", { bytes: Buffer.from("plain text payload") }), /Unsupported image type/);
  await assert.rejects(store.save("a", { bytes: Buffer.alloc(0) }), /empty/);
  const tiny = new ImageStore({ directory, maxBytes: 8 });
  await tiny.init();
  await assert.rejects(tiny.save("a", { bytes: PNG }), /exceeds/);
  assert.equal(await tiny.read("missing"), null);
});
