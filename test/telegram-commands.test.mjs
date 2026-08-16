import test from "node:test";
import assert from "node:assert/strict";
import { TelegramCommandService, formatHistoryMessage, parseHistoryHours } from "../src/telegram-commands.mjs";

const history = {
  hours: 24,
  from: "2026-08-16T00:00:00.000Z",
  to: "2026-08-17T00:00:00.000Z",
  providers: [{
    name: "GPT",
    model: "gpt-example",
    totalChecks: 100,
    failedChecks: 2,
    successRate: 98,
    avgLatencyMs: 1250,
    maxLatencyMs: 10_500,
    trend: ["operational", "degraded", "failed"]
  }]
};

test("history period parser supports hours and days with a 30 day cap", () => {
  assert.equal(parseHistoryHours(undefined, 24), 24);
  assert.equal(parseHistoryHours("1h", 24), 1);
  assert.equal(parseHistoryHours("7d", 24), 168);
  assert.equal(parseHistoryHours("90d", 24), 720);
  assert.equal(parseHistoryHours("invalid", 24), 24);
});

test("history formatter includes availability, latency, and trend", () => {
  const message = formatHistoryMessage(history, "https://status.example.com");
  assert.match(message, /可用率 98%/);
  assert.match(message, /平均 1.3s/);
  assert.match(message, /趋势 🟩🟨🟥/);
  assert.match(message, /https:\/\/status\.example\.com/);
});

test("history command only responds in the configured chat", async () => {
  const sent = [];
  let requestedHours;
  const telegram = { enabled: true, sendText: async (text, target) => sent.push({ text, target }) };
  const checkerService = {
    historySummary: ({ hours }) => { requestedHours = hours; return { ...history, hours }; },
    status: () => ({ providers: [], metadata: {} })
  };
  const commands = new TelegramCommandService({ telegram, checkerService, allowedChatId: "-1001" });

  assert.equal(await commands.handleUpdate({ message: { text: "/history 7d", chat: { id: -1001 } } }), true);
  assert.equal(requestedHours, 168);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.chatId, -1001);

  assert.equal(await commands.handleUpdate({ message: { text: "/history", chat: { id: -2002 } } }), false);
  assert.equal(sent.length, 1);
});

test("screenshot command captures and uploads the configured page", async () => {
  const sent = [];
  const image = new Uint8Array([1, 2, 3]);
  let capturedUrl;
  const telegram = {
    enabled: true,
    sendText: async (text) => sent.push(["text", text]),
    sendPhoto: async (value, options) => sent.push(["photo", value, options])
  };
  const commands = new TelegramCommandService({
    telegram,
    checkerService: { historySummary: () => history, status: () => ({ providers: [], metadata: {} }) },
    allowedChatId: "-1001",
    statusUrl: "https://status.example.com",
    screenshotUrl: "http://127.0.0.1:3000",
    captureScreenshot: async ({ url }) => { capturedUrl = url; return image; }
  });

  assert.equal(await commands.handleUpdate({ message: { text: "/screenshot", chat: { id: -1001 } } }), true);
  assert.equal(capturedUrl, "http://127.0.0.1:3000");
  assert.equal(sent[0][0], "text");
  assert.equal(sent[1][0], "photo");
  assert.deepEqual(sent[1][1], image);
  assert.match(sent[1][2].caption, /status\.example\.com/);
});
