const PERIOD_PATTERN = /^(\d+)(h|d)$/i;
const STATUS_LABELS = {
  operational: "正常",
  degraded: "较慢",
  failed: "失败",
  validation_failed: "验证失败",
  error: "异常",
  maintenance: "维护"
};

export class TelegramCommandService {
  constructor({ telegram, checkerService, allowedChatId, defaultHistoryHours = 24, statusUrl = "", screenshotUrl = "", captureScreenshot = null }) {
    this.telegram = telegram;
    this.checkerService = checkerService;
    this.allowedChatId = String(allowedChatId || "");
    this.defaultHistoryHours = defaultHistoryHours;
    this.statusUrl = String(statusUrl || "").trim();
    this.screenshotUrl = String(screenshotUrl || "").trim();
    this.captureScreenshot = captureScreenshot;
    this.offset = null;
    this.stopped = true;
    this.loopPromise = null;
  }

  start() {
    if (!this.telegram?.enabled || !this.allowedChatId || this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.run().catch((error) => {
      console.error(`[ai-status-monitor] Telegram command loop stopped: ${error.message}`);
    });
  }

  stop() {
    this.stopped = true;
  }

  async run() {
    try {
      await this.telegram.setCommands([
        { command: "status", description: "查看当前渠道状态" },
        { command: "history", description: "查看最近 24 小时历史" },
        { command: "screenshot", description: "获取状态页截图" },
        { command: "help", description: "查看机器人命令" }
      ]);
      const latest = await this.telegram.getUpdates({ offset: -1, limit: 1, timeout: 0 });
      if (latest?.length) this.offset = latest.at(-1).update_id + 1;
      console.log("[ai-status-monitor] Telegram commands enabled");
    } catch (error) {
      console.error(`[ai-status-monitor] Telegram command initialization failed: ${error.message}`);
    }

    while (!this.stopped) {
      try {
        const updates = await this.telegram.getUpdates({ offset: this.offset, timeout: 25 });
        for (const update of updates || []) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.stopped) {
          console.error(`[ai-status-monitor] Telegram command polling failed: ${error.message}`);
          await delay(5_000);
        }
      }
    }
  }

  async handleUpdate(update) {
    const message = update?.message;
    if (!message?.text || String(message.chat?.id) !== this.allowedChatId) return false;
    const [rawCommand, argument] = message.text.trim().split(/\s+/, 2);
    const command = rawCommand.toLowerCase().split("@")[0];
    const replyTarget = {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id || undefined
    };

    if (command === "/history") {
      const hours = parseHistoryHours(argument, this.defaultHistoryHours);
      const summary = this.checkerService.historySummary({ hours });
      await this.telegram.sendText(formatHistoryMessage(summary, this.statusUrl), replyTarget);
      return true;
    }
    if (command === "/status") {
      await this.telegram.sendText(formatCurrentStatus(this.checkerService.status(), this.statusUrl), replyTarget);
      return true;
    }
    if (command === "/screenshot") {
      if (!this.screenshotUrl || typeof this.captureScreenshot !== "function") {
        await this.telegram.sendText("页面截图功能尚未配置。", replyTarget);
        return true;
      }
      await this.telegram.sendText("正在生成状态页截图...", replyTarget);
      try {
        const image = await this.captureScreenshot({ url: this.screenshotUrl });
        const caption = this.statusUrl ? `状态页截图\n${this.statusUrl}` : "状态页截图";
        await this.telegram.sendPhoto(image, { ...replyTarget, caption });
      } catch (error) {
        console.error(`[ai-status-monitor] screenshot command failed: ${error.message}`);
        await this.telegram.sendText("状态页截图生成失败，请稍后重试。", replyTarget);
      }
      return true;
    }
    if (command === "/help" || command === "/start") {
      await this.telegram.sendText([
        "状态监控命令",
        "",
        "/status - 查看当前渠道状态",
        "/history - 查看最近 24 小时历史",
        "/history 1h - 查看最近 1 小时",
        "/history 7d - 查看最近 7 天",
        "/screenshot - 获取状态页截图"
      ].join("\n"), replyTarget);
      return true;
    }
    return false;
  }
}

export function parseHistoryHours(value, fallback = 24) {
  if (!value) return fallback;
  const match = String(value).trim().match(PERIOD_PATTERN);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const hours = match[2].toLowerCase() === "d" ? amount * 24 : amount;
  return Math.min(30 * 24, Math.max(1, hours));
}

export function formatHistoryMessage(summary, statusUrl = "") {
  const lines = [`最近 ${formatPeriod(summary.hours)} 历史`, `统计区间: ${formatTime(summary.from)} - ${formatTime(summary.to)}`, ""];
  for (const provider of summary.providers) {
    lines.push(`${provider.name} (${provider.model})`);
    if (!provider.totalChecks) {
      lines.push("暂无检测数据", "");
      continue;
    }
    lines.push(`可用率 ${provider.successRate}% | 检测 ${provider.totalChecks} 次 | 失败 ${provider.failedChecks} 次`);
    lines.push(`平均 ${formatLatency(provider.avgLatencyMs)} | 最大 ${formatLatency(provider.maxLatencyMs)}`);
    lines.push(`趋势 ${provider.trend.map(statusGlyph).join("")}`, "");
  }
  if (statusUrl) lines.push(`完整历史: ${statusUrl}`);
  return lines.join("\n").trim().slice(0, 4096);
}

export function formatCurrentStatus(status, statusUrl = "") {
  const lines = ["当前渠道状态", ""];
  for (const provider of status.providers || []) {
    const latest = provider.latest;
    const latency = Number.isFinite(latest?.latencyMs) ? ` | ${formatLatency(latest.latencyMs)}` : "";
    lines.push(`${statusGlyph(latest?.status)} ${provider.name}: ${STATUS_LABELS[latest?.status] || "未知"}${latency}`);
  }
  lines.push("", `更新时间: ${formatTime(status.metadata?.lastCompletedAt || status.metadata?.generatedAt)}`);
  if (statusUrl) lines.push(`状态页: ${statusUrl}`);
  return lines.join("\n").slice(0, 4096);
}

function statusGlyph(status) {
  if (status === "operational") return "🟩";
  if (status === "degraded" || status === "maintenance") return "🟨";
  return "🟥";
}

function formatLatency(value) {
  if (!Number.isFinite(value)) return "-";
  return value < 1000 ? `${value}ms` : `${Math.round(value / 100) / 10}s`;
}

function formatPeriod(hours) {
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
