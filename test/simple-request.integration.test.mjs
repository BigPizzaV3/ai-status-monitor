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
