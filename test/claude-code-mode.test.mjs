import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildClaudeCodeRequest, checkProvider } from "../src/checker.mjs";
import { loadConfig } from "../src/config.mjs";

const provider = {
  id: "claude-max",
  name: "Claude 官渠 Max",
  type: "anthropic",
  endpoint: "https://max.jojocode.com/v1/messages",
  model: "claude-opus-5-5",
  apiKey: "sk-test",
  checkMode: "claude-code"
};

async function configFile(t, value) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-status-claude-code-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "providers.json");
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
  t.after(() => { globalThis.fetch = original; });
}

test("配置支持 claude-code 模式，且要求 anthropic 类型", async (t) => {
  const [loaded] = await loadConfig(await configFile(t, [provider]));
  assert.equal(loaded.checkMode, "claude-code");
  await assert.rejects(
    loadConfig(await configFile(t, [{ ...provider, type: "openai" }])),
    /requires type anthropic/
  );
});

test("伪装请求使用官方 Claude Code 头部与 body 形状", () => {
  const request = buildClaudeCodeRequest(provider);
  assert.equal(request.url, "https://max.jojocode.com/v1/messages?beta=true");
  assert.equal(request.headers["user-agent"], "claude-cli/2.1.161 (external, cli)");
  assert.equal(request.headers["x-app"], "cli");
  assert.equal(request.headers["x-api-key"], "sk-test");
  assert.ok(request.headers["anthropic-beta"].includes("claude-code-20250219"));
  assert.equal(request.headers["anthropic-dangerous-direct-browser-access"], "true");

  const body = JSON.parse(request.body);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.temperature, 1);
  assert.equal(body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" });

  const metadata = JSON.parse(body.metadata.user_id);
  assert.match(metadata.device_id, /^[0-9a-f]{64}$/);
  assert.equal(metadata.account_uuid, "");
  assert.match(metadata.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("收到 message_start 即判定通过", async (t) => {
  mockFetch(t, async (url, init) => {
    if (url.endsWith("/v1/messages?beta=true") && init.method === "POST") {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("", { status: 200 });
  });

  const result = await checkProvider(provider, {});
  assert.equal(result.status, "operational");
  assert.match(result.message, /官方客户端伪装检测通过/);
});

test("上游返回 403 时展示真实错误", async (t) => {
  mockFetch(t, async (url, init) => {
    if (url.includes("/v1/messages?beta=true") && init.method === "POST") {
      return new Response(JSON.stringify({ error: { type: "upstream_error", message: "relay_official_client_only" } }), {
        status: 403,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("", { status: 200 });
  });

  const result = await checkProvider(provider, {});
  assert.equal(result.status, "error");
  assert.match(result.message, /HTTP 403/);
  assert.match(result.message, /relay_official_client_only/);
});

test("claude-code 模式遇到瞬时 502 会重试", async (t) => {
  let calls = 0;
  mockFetch(t, async (url, init) => {
    if (url.includes("/v1/messages?beta=true") && init.method === "POST") {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "Bad gateway" } }), {
          status: 502,
          headers: { "content-type": "application/json" }
        });
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("", { status: 200 });
  });

  const { checkAll } = await import("../src/checker.mjs");
  const results = await checkAll([provider], { concurrency: 1 });
  assert.equal(calls, 2);
  assert.equal(results[0].status, "operational");
});
