import { randomBytes, randomUUID } from "node:crypto";
import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import pLimit from "p-limit";
import { generateChallenge, validateResponse } from "./challenge.mjs";

const API_SUFFIX = /\/(chat\/completions|responses|messages)\/?$/;
const GOOGLE_ENDPOINT = /\/v\d+\w*\/models\/[^/:]+:(generateContent|streamGenerateContent)\/?$/;
const IMAGE_GENERATIONS_SUFFIX = /\/images\/generations\/?$/;

// Claude Code 伪装检测：上游（Claude Max 号池中继）只放行「官方客户端」请求，
// 判定依据不只有 UA，还包括完整的官方 CLI 头 + body 里的 system 提示词、
// cache_control 元数据和 metadata.user_id（新版为 JSON 字符串）。
// 这里的常量与 sub2api 的 claude.DefaultHeaders / createTestPayload 对齐。
const CLAUDE_CODE_UA_VERSION = "2.1.161";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_UA_VERSION} (external, cli)`;
const CLAUDE_CODE_BETA = "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const EXCLUDED_METADATA = new Set(["model", "prompt", "messages", "abortSignal"]);
const REASONING_MODELS = [/codex/i, /\bgpt-5/i, /\bo[1-9](?:-|$)/i, /\bdeepseek-r1/i, /\bqwq/i];
const MAX_RESPONSE_BODY_LENGTH = 2_000;
const DEFAULT_IMAGE_PROMPT = "一只拉布拉多犬一直用前爪举着一块牌子，牌子上写着 \"JOJO Code\"";
const DEFAULT_IMAGE_SIZE = "1024x1024";

function parseModel(model) {
  const match = model.trim().match(/^(.*?)[@#](mini|minimal|low|medium|high)$/i);
  if (match) return { modelId: match[1].trim(), reasoningEffort: ["mini", "minimal"].includes(match[2].toLowerCase()) ? "low" : match[2].toLowerCase() };
  return REASONING_MODELS.some((pattern) => pattern.test(model))
    ? { modelId: model.trim(), reasoningEffort: "medium" }
    : { modelId: model.trim() };
}

function baseUrl(endpoint) {
  return endpoint.split("?")[0].replace(API_SUFFIX, "");
}

function filteredMetadata(metadata) {
  if (!metadata) return null;
  const entries = Object.entries(metadata).filter(([key]) => !EXCLUDED_METADATA.has(key));
  return entries.length ? Object.fromEntries(entries) : null;
}

function createDiagnostics() {
  return {
    statusCode: null,
    statusText: "",
    responseBody: "",
    responseBodyRaw: "",
    responseBodyPromise: Promise.resolve("")
  };
}

function truncateBody(body) {
  const text = String(body || "").trim();
  return text.length > MAX_RESPONSE_BODY_LENGTH ? `${text.slice(0, MAX_RESPONSE_BODY_LENGTH)}...` : text;
}

function customFetch(endpoint, metadata, requestHeaders, diagnostics) {
  return async (input, init = {}) => {
    let requestInput = input;
    try {
      const requestUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const endpointUrl = new URL(endpoint);
      for (const key of new Set(endpointUrl.searchParams.keys())) {
        requestUrl.searchParams.delete(key);
        for (const value of endpointUrl.searchParams.getAll(key)) requestUrl.searchParams.append(key, value);
      }
      requestInput = input instanceof Request ? new Request(requestUrl, input) : requestUrl;
    } catch {}

    const headers = new Headers(init.headers);
    headers.set("User-Agent", "ai-status-monitor/1.0");
    for (const [key, value] of Object.entries(requestHeaders || {})) headers.set(key, value);
    const request = () => fetch(requestInput, { ...init, headers });
    let response;
    if (init.method?.toUpperCase() !== "POST" || !init.body || !metadata) response = await request();
    try {
      if (!response) response = await fetch(requestInput, { ...init, headers, body: JSON.stringify({ ...JSON.parse(init.body), ...metadata }) });
    } catch {
      if (!response) response = await request();
    }
    diagnostics.statusCode = response.status;
    diagnostics.statusText = response.statusText || "";
    diagnostics.responseBodyPromise = response.clone().text().then((body) => {
      diagnostics.responseBodyRaw = String(body || "");
      diagnostics.responseBody = truncateBody(body);
      return diagnostics.responseBody;
    }).catch(() => "");
    if (!response.ok) await diagnostics.responseBodyPromise;
    return response;
  };
}

function createModel(config, diagnostics) {
  const { modelId, reasoningEffort } = parseModel(config.model);
  const fetcher = customFetch(config.endpoint, filteredMetadata(config.metadata), config.requestHeaders, diagnostics);
  const url = baseUrl(config.endpoint);
  if (config.type === "openai") {
    const provider = createOpenAI({ apiKey: config.apiKey, baseURL: url, fetch: fetcher });
    return { model: /\/responses\/?(?:\?|$)/.test(config.endpoint) ? provider.responses(modelId) : provider.chat(modelId), reasoningEffort };
  }
  if (config.type === "anthropic") {
    return { model: createAnthropic({ apiKey: config.apiKey, baseURL: url, fetch: fetcher })(modelId) };
  }
  if (GOOGLE_ENDPOINT.test(config.endpoint)) {
    const googleUrl = config.endpoint.match(/^(https:\/\/generativelanguage\.googleapis\.com\/v\d+\w*)/)?.[1] || config.endpoint;
    return { model: createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: googleUrl, fetch: fetcher })(modelId) };
  }
  return { model: createOpenAICompatible({ name: "gemini", apiKey: config.apiKey, baseURL: url, fetch: fetcher })(modelId) };
}

async function ping(endpoint, timeoutMs = 8_000) {
  let origin;
  try { origin = new URL(endpoint).origin; } catch { return null; }
  for (const method of ["HEAD", "GET"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      await fetch(origin, { method, redirect: "manual", cache: "no-store", signal: controller.signal, headers: { "User-Agent": "ai-status-monitor/ping" } });
      return Date.now() - started;
    } catch {} finally { clearTimeout(timer); }
  }
  return null;
}

function responseBodyMessage(body) {
  if (!body) return "";
  if (typeof body !== "string") {
    try { body = JSON.stringify(body); } catch { body = String(body); }
  }
  const raw = truncateBody(body);
  try {
    const parsed = JSON.parse(raw);
    const error = parsed?.error;
    const message = typeof error === "string"
      ? error
      : error?.message || parsed?.message || parsed?.detail || parsed?.details;
    const code = typeof error === "object" ? error?.code || error?.type : parsed?.code || parsed?.type;
    if (message && code && !String(message).includes(String(code))) return `${code}: ${message}`;
    if (message) return String(message);
  } catch {}
  return raw;
}

function httpLabel(statusCode, statusText) {
  return statusCode ? `HTTP ${statusCode}${statusText ? ` ${statusText}` : ""}` : "";
}

function errorMessage(error, diagnostics) {
  if (error?.name === "AbortError" || /request was aborted|timeout/i.test(error?.message || "")) return "请求超时";
  const statusCode = error?.statusCode ?? diagnostics?.statusCode;
  const statusText = error?.statusText || diagnostics?.statusText || "";
  const body = responseBodyMessage(error?.responseBody || diagnostics?.responseBody);
  const message = body || error?.message || "未知错误";
  const http = httpLabel(statusCode, statusText);
  return http ? `${http} · ${message}` : message;
}

function emptyResponseMessage(diagnostics, timeoutMs, timedOut) {
  const http = httpLabel(diagnostics?.statusCode, diagnostics?.statusText);
  const body = responseBodyMessage(diagnostics?.responseBody);
  if (timedOut) return `${http ? `${http} · ` : ""}请求超时（${timeoutMs}ms，未收到上游响应）`;
  if (http && body) return `${http} · 上游返回空回复，响应内容：${body}`;
  if (http) return `${http} · 上游返回空回复`;
  if (body) return `回复为空，响应内容：${body}`;
  return "回复为空";
}

function imageGenerationsUrl(endpoint) {
  const url = new URL(endpoint);
  if (IMAGE_GENERATIONS_SUFFIX.test(url.pathname)) return url.toString();
  return `${baseUrl(endpoint)}/images/generations`;
}

// Accept either inline base64 or a hosted URL. Any other payload (empty data,
// error object, placeholder JSON) must not be reported as a successful image.
export function validateImageResponse(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return { ok: false, message: "上游返回的不是 JSON" }; }
  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!item || typeof item !== "object") return { ok: false, message: "响应中没有图片数据" };
  const base64 = typeof item.b64_json === "string" ? item.b64_json.trim() : "";
  if (base64) {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length) return { ok: true, bytes };
  }
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (/^https?:\/\//i.test(url)) return { ok: true, url };
  return { ok: false, message: "响应中的图片既没有 b64_json 也没有 url" };
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

// Keep the produced image so the status page can show the latest one. Inline
// base64 needs no extra request; hosted URLs are downloaded right away because
// they usually expire.
async function loadGeneratedImage(validation, downloadTimeoutMs) {
  if (validation.bytes?.length) return { bytes: validation.bytes };
  if (!validation.url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
  try {
    const response = await fetch(validation.url, {
      signal: controller.signal,
      headers: { "user-agent": "ai-status-monitor/1.0" }
    });
    if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("图片超过 32MB");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("图片内容为空");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("图片超过 32MB");
    return { bytes, mimeType: response.headers.get("content-type") || undefined };
  } finally {
    clearTimeout(timer);
  }
}

const IMAGE_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_IMAGE_RETRY_DELAYS = [3_000, 8_000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchImageOnce(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text };
}

async function checkImageProvider(config, options = {}) {
  const timeoutMs = config.timeoutMs ?? options.timeoutMs ?? 240_000;
  const degradedMs = config.degradedMs ?? options.degradedMs ?? 120_000;
  const retryDelays = Array.isArray(options.imageRetryDelays) ? options.imageRetryDelays : DEFAULT_IMAGE_RETRY_DELAYS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const pingPromise = ping(config.endpoint);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
    "user-agent": "ai-status-monitor/1.0"
  };
  for (const [key, value] of Object.entries(config.requestHeaders || {})) headers[key] = value;
  const body = JSON.stringify({
    model: parseModel(config.model).modelId,
    prompt: config.imagePrompt || config.simplePrompt || DEFAULT_IMAGE_PROMPT,
    n: 1,
    size: config.imageSize || DEFAULT_IMAGE_SIZE
  });
  // A relay may answer 429/5xx when no upstream account is free at that
  // instant. Those responses contain no image, so retrying briefly cannot bill
  // a second generation and keeps the hourly probe from flapping.
  const attempts = retryDelays.length + 1;
  let lastFailure = null;
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(retryDelays[attempt - 1] ?? 0);
      let response;
      let text;
      try {
        ({ response, text } = await fetchImageOnce(imageGenerationsUrl(config.endpoint), {
          method: "POST",
          headers,
          body,
          signal: controller.signal
        }));
      } catch (error) {
        const latencyMs = Date.now() - started;
        if (error?.name === "AbortError") return result(config, "error", latencyMs, await pingPromise, `请求超时（${timeoutMs}ms）`);
        lastFailure = { latencyMs, message: errorMessage(error) };
        if (attempt < attempts - 1) continue;
        return result(config, "error", latencyMs, await pingPromise, lastFailure.message);
      }
      const latencyMs = Date.now() - started;
      const pingLatencyMs = await pingPromise;
      if (!response.ok) {
        const detail = responseBodyMessage(text) || "生图请求失败";
        const message = `${httpLabel(response.status, response.statusText)} · ${detail}`;
        if (IMAGE_RETRY_STATUSES.has(response.status) && attempt < attempts - 1) {
          lastFailure = { latencyMs, message };
          continue;
        }
        return result(config, "error", latencyMs, pingLatencyMs, message);
      }
      const validation = validateImageResponse(text);
      if (!validation.ok) return result(config, "failed", latencyMs, pingLatencyMs, `生图响应无效：${validation.message}`);
      let image = null;
      let imageWarning = "";
      try {
        image = await loadGeneratedImage(validation, Math.max(5_000, Math.min(timeoutMs, 45_000)));
      } catch (error) {
        imageWarning = `（图片下载失败：${error?.message || "未知错误"}）`;
      }
      const size = image?.bytes?.length ? `，约 ${Math.round(image.bytes.length / 1024)} KB` : "";
      const status = latencyMs <= degradedMs ? "operational" : "degraded";
      const message = status === "operational" ? `生图成功 (${latencyMs}ms${size})${imageWarning}` : `生图成功但耗时 ${latencyMs}ms${size}${imageWarning}`;
      return { ...result(config, status, latencyMs, pingLatencyMs, message), image };
    }
    return result(config, "error", Date.now() - started, await pingPromise, lastFailure?.message || "生图请求失败");
  } finally {
    clearTimeout(timer);
  }
}

// 伪装检测固定走 /v1/messages?beta=true；endpoint 既可能是完整的 messages
// 地址，也可能只是站点根地址，这里统一归一化。
function claudeCodeUrl(endpoint) {
  const url = new URL(endpoint);
  if (/\/v1\/messages\/?$/.test(url.pathname)) {
    url.search = "beta=true";
    return url.toString();
  }
  const base = endpoint.split("?")[0].replace(/\/+$/, "");
  return `${base}/v1/messages?beta=true`;
}

function claudeCodeHeaders(config) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": CLAUDE_CODE_BETA,
    "user-agent": CLAUDE_CODE_USER_AGENT,
    "x-app": "cli",
    "x-stainless-lang": "js",
    "x-stainless-package-version": "0.94.0",
    "x-stainless-os": "Linux",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "600",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-api-key": config.apiKey
  };
  for (const [key, value] of Object.entries(config.requestHeaders || {})) headers[key] = value;
  return headers;
}

/** 构造与官方 Claude Code CLI 等价的请求（Headers + SSE Body） */
export function buildClaudeCodeRequest(config) {
  const metadata = JSON.stringify({
    device_id: randomBytes(32).toString("hex"),
    account_uuid: "",
    session_id: randomUUID()
  });
  const body = {
    model: parseModel(config.model).modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    metadata: { user_id: metadata },
    max_tokens: 1024,
    temperature: 1,
    stream: true
  };
  return {
    url: claudeCodeUrl(config.endpoint),
    headers: claudeCodeHeaders(config),
    body: JSON.stringify(body)
  };
}

/**
 * Claude Code 伪装检测：发一条官方形状的流式请求，收到 message_start 即算通过。
 * 收到首个事件后立即断开，避免多消耗上游 token（与 sub2api 账号测试一致）。
 */
async function checkClaudeCodeProvider(config, options = {}) {
  const timeoutMs = config.timeoutMs ?? options.timeoutMs ?? 45_000;
  const degradedMs = config.degradedMs ?? options.degradedMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const pingPromise = ping(config.endpoint);
  const request = buildClaudeCodeRequest(config);
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const latencyMs = Date.now() - started;
      const detail = responseBodyMessage(text) || "官方客户端伪装请求被拒绝";
      return result(config, "error", latencyMs, await pingPromise, `${httpLabel(response.status, response.statusText)} · ${detail}`);
    }

    let text = "";
    let sawMessageStart = false;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (/event:\s*message_start/.test(text) || /"type"\s*:\s*"message_start"/.test(text)) {
            sawMessageStart = true;
            break;
          }
          if (/event:\s*error/.test(text) || /"type"\s*:\s*"error"/.test(text)) break;
          if (Buffer.byteLength(text) > 256 * 1024) break;
        }
      } catch (error) {
        if (!sawMessageStart) throw error;
      } finally {
        // 拿到结果就不再读流：abort 掉连接，上游只产生极少量 token。
        try { controller.abort(); } catch {}
        try { reader.cancel().catch(() => {}); } catch {}
      }
    }

    const latencyMs = Date.now() - started;
    const pingLatencyMs = await pingPromise;
    if (!sawMessageStart) {
      const errorBlock = text.split(/\r?\n\r?\n/).find((block) => /"type"\s*:\s*"error"/.test(block) || /event:\s*error/.test(block)) || "";
      const payload = parseSSEData(errorBlock);
      const detail = payload?.error?.message || payload?.message || responseBodyMessage(text) || "未收到 message_start 事件";
      return result(config, "error", latencyMs, pingLatencyMs, `${httpLabel(response.status, response.statusText) || "SSE"} · ${detail}`);
    }
    const status = latencyMs <= degradedMs ? "operational" : "degraded";
    return result(
      config,
      status,
      latencyMs,
      pingLatencyMs,
      status === "degraded" ? `官方客户端伪装通过但耗时 ${latencyMs}ms` : `官方客户端伪装检测通过 (${latencyMs}ms)`
    );
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (error?.name === "AbortError") {
      return result(config, "error", latencyMs, await pingPromise, `请求超时（${timeoutMs}ms）`);
    }
    return result(config, "error", latencyMs, await pingPromise, errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

function parseSSEData(block) {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try { return JSON.parse(data); } catch { return null; }
}

// Some OpenAI-compatible relays return Responses SSE with HTTP 200 but omit
// headers/events that the AI SDK needs to populate textStream. Parse the
// completion event as a compatibility fallback, without treating arbitrary
// response text as success.
export function parseResponsesSSE(body) {
  const raw = String(body || "");
  if (!raw.includes("data:")) return null;

  let text = "";
  let deltaSeen = false;
  let completed = false;
  let failed = false;
  let sawResponsesEvent = false;

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "";
    const payload = parseSSEData(block);
    if (!event && !payload) continue;
    if (event.startsWith("response.")) sawResponsesEvent = true;

    if (event === "response.output_text.delta" && typeof payload?.delta === "string") {
      text += payload.delta;
      deltaSeen = true;
    } else if (event === "response.output_text.done" && !deltaSeen && typeof payload?.text === "string") {
      text = payload.text;
    }

    const responseStatus = payload?.response?.status;
    if (event === "response.completed" || event === "response.done") {
      completed = !["failed", "incomplete", "cancelled"].includes(String(responseStatus || "").toLowerCase());
    }
    if (event === "response.failed" || event === "response.incomplete" || event === "error") failed = true;
    if (payload?.error && (event === "error" || event === "response.failed")) failed = true;
  }

  if (!sawResponsesEvent) return null;
  return { text, completed, failed };
}

function isRetryableAbort(checked) {
  return checked.status === "error" && /request was aborted|请求超时/i.test(checked.message);
}

// Claude Code 伪装检测打的是号池中继，Cloudflare 偶发 502/503/504；
// 这类瞬时错误重试一次即可，持续不可用的话最终仍会记录为异常。
function isRetryableClaudeCodeError(config, checked) {
  if (config.checkMode !== "claude-code" || checked.status !== "error") return false;
  return /HTTP 5\d\d/i.test(checked.message || "");
}

function result(config, status, latencyMs, pingLatencyMs, message) {
  return { id: config.id, name: config.name, type: config.type, endpoint: config.endpoint, model: config.model, status, latencyMs, pingLatencyMs, checkedAt: new Date().toISOString(), message, groupName: config.groupName };
}

export function createProbe(config, challengeFactory = generateChallenge) {
  if (config.checkMode === "simple") {
    return { prompt: config.simplePrompt || "hi", expectedAnswer: null, mode: "simple" };
  }
  return { ...challengeFactory(), mode: "challenge" };
}

export function validateProbeResponse(text, probe) {
  if (!text.trim()) return { valid: false, message: "回复为空" };
  if (probe.mode === "simple") return { valid: true };
  const validation = validateResponse(text, probe.expectedAnswer);
  if (validation.valid) return { valid: true };
  return {
    valid: false,
    message: `回复验证失败: 期望 "${probe.expectedAnswer}", 实际: "${validation.normalized || "(空)"}"`
  };
}

export async function checkProvider(config, options = {}) {
  if (config.checkMode === "image") return checkImageProvider(config, options);
  if (config.checkMode === "claude-code") return checkClaudeCodeProvider(config, options);
  const timeoutMs = config.timeoutMs ?? options.timeoutMs ?? 45_000;
  const degradedMs = config.degradedMs ?? options.degradedMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const pingPromise = ping(config.endpoint);
  const diagnostics = createDiagnostics();
  try {
    const probe = createProbe(config, options.generateChallenge || generateChallenge);
    const { model, reasoningEffort } = createModel(config, diagnostics);
    let streamError = null;
    const response = streamText({
      model,
      prompt: probe.prompt,
      abortSignal: controller.signal,
      ...(reasoningEffort && config.type === "openai" ? { providerOptions: { openai: { reasoningEffort } } } : {}),
      ...(reasoningEffort ? {} : { maxOutputTokens: 24 }),
      onError({ error }) { streamError = error; }
    });
    let text = "";
    for await (const chunk of response.textStream) text += chunk;
    await diagnostics.responseBodyPromise;
    const sseFallback = parseResponsesSSE(diagnostics.responseBodyRaw);
    if (sseFallback?.completed && !sseFallback.failed && sseFallback.text.trim()) {
      // Prefer the fallback only when it proves a completed Responses stream.
      // This also suppresses an SDK parser error caused by the relay framing.
      text = text.trim() ? text : sseFallback.text;
      streamError = null;
    }
    const latencyMs = Date.now() - started;
    const pingLatencyMs = await pingPromise;
    if (streamError) return result(config, "error", latencyMs, pingLatencyMs, errorMessage(streamError, diagnostics));
    const validation = validateProbeResponse(text, probe);
    if (!validation.valid && !text.trim()) validation.message = emptyResponseMessage(diagnostics, timeoutMs, controller.signal.aborted);
    if (!validation.valid) {
      const status = probe.mode === "simple" ? "failed" : "validation_failed";
      return result(config, status, latencyMs, pingLatencyMs, validation.message);
    }
    const status = latencyMs <= degradedMs ? "operational" : "degraded";
    const successMessage = probe.mode === "simple" ? `回复成功 (${latencyMs}ms)` : `验证通过 (${latencyMs}ms)`;
    return result(config, status, latencyMs, pingLatencyMs, status === "degraded" ? `响应成功但耗时 ${latencyMs}ms` : successMessage);
  } catch (error) {
    await diagnostics.responseBodyPromise;
    return result(config, "error", null, await pingPromise, errorMessage(error, diagnostics));
  } finally {
    clearTimeout(timer);
  }
}

async function checkWithRetry(config, options) {
  // Image generation is expensive: retrying an aborted generation can bill a
  // second image, so the image probe never retries.
  const attempts = config.checkMode === "image" ? 1 : 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const checked = await checkProvider(config, options);
    const retryable = isRetryableAbort(checked) || isRetryableClaudeCodeError(config, checked);
    if (!retryable || attempt === attempts - 1) return checked;
  }
}

export async function checkAll(providers, options = {}) {
  const limit = pLimit(options.concurrency ?? 5);
  // Image generations consume scarce upstream capacity, so they run one at a
  // time instead of competing with each other (and the text probes).
  const imageLimit = pLimit(options.imageConcurrency ?? 1);
  const check = options.checkProvider
    ? async (config) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const checked = await options.checkProvider(config, options);
          if (!isRetryableAbort(checked) || attempt === 2) return checked;
        }
      }
    : (config) => checkWithRetry(config, options);
  return Promise.all(providers
    .filter((item) => !item.isMaintenance)
    .map((item) => (item.checkMode === "image" ? imageLimit : limit)(() => check(item))));
}
