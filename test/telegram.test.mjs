import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramNotifier } from "../src/telegram.mjs";

test("Telegram notifier sends a message to a configured topic", async () => {
  let url;
  let options;
  const notifier = createTelegramNotifier({
    botToken: "123456:token-value",
    chatId: "-1001234567890",
    messageThreadId: "42",
    fetchImpl: async (target, request) => {
      url = target;
      options = request;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });

  assert.equal(notifier.enabled, true);
  await notifier.send({ subject: "故障", text: "渠道检测失败" });
  assert.equal(url, "https://api.telegram.org/bot123456:token-value/sendMessage");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), {
    chat_id: "-1001234567890",
    text: "故障\n\n渠道检测失败",
    disable_web_page_preview: true,
    message_thread_id: 42
  });
});

test("Telegram notifier is disabled when credentials are missing", () => {
  const notifier = createTelegramNotifier({ chatId: "123" });
  assert.equal(notifier.enabled, false);
  assert.match(notifier.reason, /TELEGRAM_BOT_TOKEN/);
});

test("Telegram notifier reports API errors without including the bot token", async () => {
  const token = "123456:sensitive-token";
  const notifier = createTelegramNotifier({
    botToken: token,
    chatId: "123",
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: "Forbidden" }) })
  });

  await assert.rejects(notifier.send({ subject: "故障", text: "失败" }), (error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
});
