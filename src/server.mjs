import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { HistoryStore } from "./store.mjs";
import { checkAll } from "./checker.mjs";
import { CheckerService } from "./service.mjs";
import { transformStatus } from "./status-view.mjs";
import { booleanEnv } from "./env.mjs";
import { loadSiteConfig, renderSiteHtml } from "./site.mjs";
import { createEmailNotifier } from "./email.mjs";
import { createTelegramNotifier } from "./telegram.mjs";
import { createNotifierGroup } from "./notifier.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(root, "../public");

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const port = numberEnv("PORT", 3000, 1, 65535);
const showOverallAlert = booleanEnv("SHOW_OVERALL_ALERT", false);
const defaultGroupsExpanded = booleanEnv("DEFAULT_GROUPS_EXPANDED", true);
const site = loadSiteConfig();
const intervalMs = numberEnv("CHECK_POLL_INTERVAL_SECONDS", 120, 15, 3600) * 1000;
const providers = await loadConfig(process.env.CONFIG_FILE || "/app/config/providers.json");
const store = new HistoryStore(process.env.HISTORY_FILE || "/app/data/history.json", numberEnv("HISTORY_RETENTION_DAYS", 30, 1, 365));
await store.init();
const smtpUsername = process.env.SMTP_USERNAME?.trim() || "";
const emailNotifier = createEmailNotifier({
  host: process.env.SMTP_HOST?.trim(),
  port: numberEnv("SMTP_PORT", 465, 1, 65535),
  username: smtpUsername,
  password: process.env.SMTP_PASSWORD,
  from: process.env.SMTP_FROM?.trim() || smtpUsername,
  fromName: process.env.SMTP_FROM_NAME?.trim(),
  useTls: booleanEnv("SMTP_USE_TLS", true),
  recipients: process.env.ALERT_EMAIL_TO?.trim() || smtpUsername
});
if (emailNotifier.enabled) console.log("[ai-status-monitor] email alerts enabled");
else if (emailNotifier.reason) console.warn(`[ai-status-monitor] ${emailNotifier.reason}`);
const telegramNotifier = createTelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  messageThreadId: process.env.TELEGRAM_MESSAGE_THREAD_ID
});
if (telegramNotifier.enabled) console.log("[ai-status-monitor] Telegram alerts enabled");
else if (telegramNotifier.reason) console.warn(`[ai-status-monitor] ${telegramNotifier.reason}`);
const alertNotifier = createNotifierGroup([
  { name: "email", notifier: emailNotifier },
  { name: "Telegram", notifier: telegramNotifier }
]);
const service = new CheckerService({
  providers,
  store,
  checkAll,
  intervalMs,
  concurrency: numberEnv("CHECK_CONCURRENCY", 5, 1, 20),
  timeoutMs: numberEnv("CHECK_TIMEOUT_MS", 45_000, 2_000, 120_000),
  degradedMs: numberEnv("DEGRADED_THRESHOLD_MS", 10_000, 1_000, 120_000),
  apiHistoryPoints: numberEnv("API_HISTORY_POINTS", 91, 1, 1000),
  alertNotifier,
  alertConsecutiveFailures: numberEnv("ALERT_CONSECUTIVE_FAILURES", 3, 1, 100)
});

function historyPage(url) {
  const value = Number(url.searchParams.get("historyPage"));
  return Number.isInteger(value) ? Math.min(10_000, Math.max(0, value)) : 0;
}

async function serveFile(response, fileName, contentType) {
  try {
    const body = await fs.readFile(path.join(publicDir, fileName));
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function serveIndex(response) {
  try {
    const template = await fs.readFile(path.join(publicDir, "index.html"), "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderSiteHtml(template, site));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    const ready = service.status().providers.some((provider) => provider.latest);
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    return response.end(JSON.stringify({ ok: ready, providers: providers.length, running: Boolean(service.running), lastCompletedAt: service.lastCompletedAt }));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/status") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return response.end(JSON.stringify(service.status({ historyPage: historyPage(url) })));
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return response.end(JSON.stringify({
      ...transformStatus(service.status({ historyPage: historyPage(url) })),
      showOverallAlert,
      defaultGroupsExpanded,
      site
    }));
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/history" || url.pathname === "/history/")) {
    return serveIndex(response);
  }
  if (request.method === "GET" && url.pathname === "/favicon.svg") return serveFile(response, "favicon.svg", "image/svg+xml");
  if (request.method === "GET" && url.pathname === "/app.css") return serveFile(response, "app.css", "text/css; charset=utf-8");
  if (request.method === "GET" && url.pathname === "/app.js") return serveFile(response, "app.js", "text/javascript; charset=utf-8");
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[ai-status-monitor] listening on :${port}; providers=${providers.length}; interval=${intervalMs}ms`);
  service.start();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    service.stop();
    server.close(() => process.exit(0));
  });
}
