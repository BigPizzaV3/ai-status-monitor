export function createTelegramNotifier({ botToken, chatId, messageThreadId, fetchImpl = globalThis.fetch } = {}) {
  const token = String(botToken || "").trim();
  const target = String(chatId || "").trim();
  const thread = String(messageThreadId || "").trim();
  const missing = [
    ["TELEGRAM_BOT_TOKEN", token],
    ["TELEGRAM_CHAT_ID", target]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) return disabled(`Telegram 告警未启用，缺少配置: ${missing.join(", ")}`);
  if (typeof fetchImpl !== "function") return disabled("Telegram 告警未启用，当前运行环境不支持 fetch");

  const numericThread = thread ? Number(thread) : null;
  if (thread && (!Number.isInteger(numericThread) || numericThread <= 0)) {
    return disabled("Telegram 告警未启用，TELEGRAM_MESSAGE_THREAD_ID 必须为正整数");
  }

  return {
    enabled: true,
    async send({ subject, text }) {
      return this.sendText(`${subject}\n\n${text}`);
    },
    async sendText(text, { chatId: destination = target, messageThreadId: destinationThread = numericThread } = {}) {
      const payload = {
        chat_id: String(destination),
        text: String(text).slice(0, 4096),
        disable_web_page_preview: true
      };
      if (destinationThread) payload.message_thread_id = Number(destinationThread);
      await request("sendMessage", payload);
      return true;
    },
    async getUpdates({ offset, limit = 50, timeout = 25 } = {}) {
      const payload = { limit, timeout, allowed_updates: ["message"] };
      if (Number.isInteger(offset)) payload.offset = offset;
      return request("getUpdates", payload, (timeout + 10) * 1000);
    },
    async setCommands(commands) {
      await request("setMyCommands", { commands });
      return true;
    }
  };

  async function request(method, payload, timeoutMs = 15_000) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new Error("Telegram API request failed");
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      // The HTTP status still provides a useful error when Telegram returns a non-JSON body.
    }
    if (!response.ok || result?.ok === false) {
      const description = typeof result?.description === "string" ? `: ${result.description.slice(0, 200)}` : "";
      throw new Error(`Telegram API error (${response.status})${description}`);
    }
    return result?.result;
  }
}

function disabled(reason) {
  return {
    enabled: false,
    reason,
    async send() { return false; }
  };
}
