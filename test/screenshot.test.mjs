import test from "node:test";
import assert from "node:assert/strict";
import { capturePageScreenshot } from "../src/screenshot.mjs";

test("screenshot capture opens the page, expands groups, and closes Chromium", async () => {
  const calls = [];
  let closed = false;
  const image = new Uint8Array([1, 2, 3]);
  const page = {
    setViewport: async (value) => calls.push(["viewport", value]),
    goto: async (url, options) => calls.push(["goto", url, options]),
    waitForSelector: async (selector) => calls.push(["selector", selector]),
    evaluate: async () => calls.push(["evaluate"]),
    screenshot: async (options) => { calls.push(["screenshot", options]); return image; }
  };
  const launcher = {
    launch: async (options) => {
      calls.push(["launch", options]);
      return { newPage: async () => page, close: async () => { closed = true; } };
    }
  };

  const result = await capturePageScreenshot({ url: "http://127.0.0.1:3000", executablePath: "/bin/sh", launcher });
  assert.deepEqual(result, image);
  assert.equal(calls.find(([name]) => name === "goto")[1], "http://127.0.0.1:3000");
  assert.equal(calls.find(([name]) => name === "screenshot")[1].fullPage, true);
  assert.equal(closed, true);
});
