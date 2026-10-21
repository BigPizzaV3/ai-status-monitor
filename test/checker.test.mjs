import test from "node:test";
import assert from "node:assert/strict";
import { checkAll, checkProvider, parseResponsesSSE, validateImageResponse } from "../src/checker.mjs";

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

test("parseResponsesSSE accepts a completed Responses stream", () => {
  const parsed = parseResponsesSSE([
    "event: response.created",
    'data: {"response":{"status":"in_progress"}}',
    "",
    "event: response.output_text.delta",
    'data: {"delta":"Hi! What can I help you with?"}',
    "",
    "event: response.completed",
    'data: {"response":{"status":"completed"}}',
    ""
  ].join("\n"));

  assert.deepEqual(parsed, {
    text: "Hi! What can I help you with?",
    completed: true,
    failed: false
  });
});

test("parseResponsesSSE rejects failed and incomplete streams", () => {
  const failed = parseResponsesSSE([
    "event: response.output_text.delta",
    'data: {"delta":"partial"}',
    "",
    "event: response.failed",
    'data: {"error":{"message":"upstream failed"}}',
    ""
  ].join("\n"));
  const incomplete = parseResponsesSSE([
    "event: response.output_text.delta",
    'data: {"delta":"partial"}',
    "",
    "event: response.incomplete",
    'data: {"response":{"status":"incomplete"}}',
    ""
  ].join("\n"));

  assert.equal(failed?.failed, true);
  assert.equal(failed?.completed, false);
  assert.equal(incomplete?.failed, true);
  assert.equal(incomplete?.completed, false);
});

test("parseResponsesSSE does not accept a stream without completion", () => {
  const parsed = parseResponsesSSE([
    "event: response.output_text.delta",
    'data: {"delta":"partial"}',
    ""
  ].join("\n"));

  assert.deepEqual(parsed, { text: "partial", completed: false, failed: false });
});

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function imageResponse() {
  return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
}

const imageProvider = {
  id: "image",
  name: "Image",
  type: "openai",
  endpoint: "https://example.com/v1/responses",
  model: "gpt-image-2",
  apiKey: "secret",
  checkMode: "image",
  kind: "image",
  imagePrompt: "test image",
  imageSize: "1024x1024",
  timeoutMs: 5_000,
  degradedMs: 60_000
};

test("image probe posts a real generation request and accepts a hosted result", async () => {
  const calls = [];
  const restore = stubFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method !== "POST") {
      return String(url).includes("cdn.example.com") ? imageResponse() : new Response("", { status: 200 });
    }
    return jsonResponse({ created: 1, data: [{ url: "https://cdn.example.com/a.png" }] });
  });
  try {
    const checked = await checkProvider(imageProvider);
    assert.equal(checked.status, "operational");
    assert.match(checked.message, /生图成功/);
    assert.ok(checked.image?.bytes?.equals(PNG_BYTES), "generated image bytes must be retained");
    const post = calls.find((call) => call.init?.method === "POST");
    assert.equal(post.url, "https://example.com/v1/images/generations");
    assert.deepEqual(JSON.parse(post.init.body), { model: "gpt-image-2", prompt: "test image", n: 1, size: "1024x1024" });
    assert.equal(post.init.headers.authorization, "Bearer secret");
  } finally {
    restore();
  }
});

test("image probe reports invalid payloads as failed", async () => {
  const restore = stubFetch(async (url, init) => init?.method === "POST"
    ? jsonResponse({ data: [] })
    : new Response("", { status: 200 }));
  try {
    const checked = await checkProvider(imageProvider);
    assert.equal(checked.status, "failed");
    assert.match(checked.message, /生图响应无效/);
  } finally {
    restore();
  }
});

test("image probe surfaces upstream HTTP errors", async () => {
  const restore = stubFetch(async (url, init) => init?.method === "POST"
    ? jsonResponse({ error: { message: "model not allowed" } }, 403)
    : new Response("", { status: 200 }));
  try {
    const checked = await checkProvider(imageProvider);
    assert.equal(checked.status, "error");
    assert.match(checked.message, /403/);
    assert.match(checked.message, /model not allowed/);
  } finally {
    restore();
  }
});

test("validateImageResponse accepts base64 or url and rejects placeholders", () => {
  assert.equal(validateImageResponse(JSON.stringify({ data: [{ b64_json: Buffer.from("hello").toString("base64") }] })).ok, true);
  assert.equal(validateImageResponse(JSON.stringify({ data: [{ url: "https://cdn.example.com/a.png" }] })).ok, true);
  assert.equal(validateImageResponse(JSON.stringify({ data: [{ url: "not-a-url" }] })).ok, false);
  assert.equal(validateImageResponse("not json").ok, false);
});

test("image probe retries transient capacity errors and then succeeds", async () => {
  let calls = 0;
  const restore = stubFetch(async (url, init) => {
    if (init?.method !== "POST") return new Response("", { status: 200 });
    calls += 1;
    return calls < 3
      ? jsonResponse({ error: { message: "No available compatible accounts" } }, 503)
      : jsonResponse({ data: [{ url: "https://cdn.example.com/a.png" }] });
  });
  try {
    const checked = await checkProvider(imageProvider, { imageRetryDelays: [0, 0] });
    assert.equal(checked.status, "operational");
    assert.equal(calls, 3);
  } finally {
    restore();
  }
});

test("image probe stops retrying after the transient attempts are exhausted", async () => {
  let calls = 0;
  const restore = stubFetch(async (url, init) => {
    if (init?.method !== "POST") return new Response("", { status: 200 });
    calls += 1;
    return jsonResponse({ error: { message: "No available compatible accounts" } }, 503);
  });
  try {
    const checked = await checkProvider(imageProvider, { imageRetryDelays: [0, 0] });
    assert.equal(checked.status, "error");
    assert.match(checked.message, /503/);
    assert.equal(calls, 3);
  } finally {
    restore();
  }
});

test("image probe does not retry non-transient HTTP errors", async () => {
  let calls = 0;
  const restore = stubFetch(async (url, init) => {
    if (init?.method !== "POST") return new Response("", { status: 200 });
    calls += 1;
    return jsonResponse({ error: { message: "model not allowed" } }, 403);
  });
  try {
    const checked = await checkProvider(imageProvider, { imageRetryDelays: [0, 0] });
    assert.equal(checked.status, "error");
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test("checkAll serializes image probes while text probes run in parallel", async () => {
  let activeImages = 0;
  let maxActiveImages = 0;
  let activeText = 0;
  let maxActiveText = 0;
  const providers = [
    { id: "i1", checkMode: "image" },
    { id: "i2", checkMode: "image" },
    { id: "i3", checkMode: "image" },
    { id: "t1" },
    { id: "t2" },
    { id: "t3" }
  ];
  const results = await checkAll(providers, {
    concurrency: 3,
    imageConcurrency: 1,
    checkProvider: async (config) => {
      const isImage = config.checkMode === "image";
      if (isImage) {
        activeImages += 1;
        maxActiveImages = Math.max(maxActiveImages, activeImages);
      } else {
        activeText += 1;
        maxActiveText = Math.max(maxActiveText, activeText);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (isImage) activeImages -= 1;
      else activeText -= 1;
      return checked("operational", "ok");
    }
  });
  assert.equal(results.length, 6);
  assert.equal(maxActiveImages, 1);
  assert.ok(maxActiveText > 1);
});

test("image probe keeps inline base64 images without an extra download", async () => {
  let downloads = 0;
  const restore = stubFetch(async (url, init) => {
    if (init?.method === "POST") return jsonResponse({ data: [{ b64_json: PNG_BYTES.toString("base64") }] });
    if (String(url).includes("cdn.example.com")) downloads += 1;
    return new Response("", { status: 200 });
  });
  try {
    const checked = await checkProvider(imageProvider);
    assert.equal(checked.status, "operational");
    assert.ok(checked.image?.bytes?.equals(PNG_BYTES));
    assert.equal(downloads, 0);
  } finally {
    restore();
  }
});

test("image probe stays operational when the image download fails", async () => {
  const restore = stubFetch(async (url, init) => {
    if (init?.method !== "POST") return new Response("missing", { status: 404 });
    return jsonResponse({ data: [{ url: "https://cdn.example.com/gone.png" }] });
  });
  try {
    const checked = await checkProvider(imageProvider);
    assert.equal(checked.status, "operational");
    assert.match(checked.message, /图片下载失败/);
    assert.equal(checked.image, null);
  } finally {
    restore();
  }
});
