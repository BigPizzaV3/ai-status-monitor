import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { checkProvider } from "../src/checker.mjs";

test("simple mode sends hi through an OpenAI-compatible streaming request", async (t) => {
  let requestBody;
  const server = http.createServer(async (request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;
    requestBody = JSON.parse(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const result = await checkProvider({
    id: "simple",
    name: "Simple",
    type: "openai",
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: "test-model",
    apiKey: "test-key",
    checkMode: "simple",
    simplePrompt: "hi"
  });

  assert.equal(requestBody.messages[0].content, "hi");
  assert.equal(requestBody.stream, true);
  assert.equal(result.status, "operational");
  assert.match(result.message, /^回复成功/);
});

test("provider HTTP errors include status and response message", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "请求过于频繁" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const result = await checkProvider({
    id: "rate-limited",
    name: "Rate limited",
    type: "openai",
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: "test-model",
    apiKey: "test-key",
    checkMode: "simple",
    simplePrompt: "hi"
  });

  assert.equal(result.status, "error");
  assert.match(result.message, /HTTP 429/);
  assert.match(result.message, /rate_limit_exceeded/);
  assert.match(result.message, /请求过于频繁/);
});

test("empty provider replies include the HTTP status", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const result = await checkProvider({
    id: "empty",
    name: "Empty",
    type: "openai",
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: "test-model",
    apiKey: "test-key",
    checkMode: "simple",
    simplePrompt: "hi"
  });

  assert.equal(result.status, "failed");
  assert.match(result.message, /HTTP 200/);
  assert.match(result.message, /上游返回空回复/);
});

test("providers that abort without an SDK error are reported as timed out", async (t) => {
  const server = http.createServer((request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200).end();
      return;
    }
    request.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const { port } = server.address();
  const result = await checkProvider({
    id: "timeout",
    name: "Timeout",
    type: "openai",
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: "test-model",
    apiKey: "test-key",
    checkMode: "simple",
    simplePrompt: "hi"
  }, { timeoutMs: 50 });

  assert.equal(result.status, "failed");
  assert.match(result.message, /请求超时/);
  assert.match(result.message, /50ms/);
});
