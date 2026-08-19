import { streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import pLimit from "p-limit";
import { generateChallenge, validateResponse } from "./challenge.mjs";

const API_SUFFIX = /\/(chat\/completions|responses|messages)\/?$/;
const GOOGLE_ENDPOINT = /\/v\d+\w*\/models\/[^/:]+:(generateContent|streamGenerateContent)\/?$/;
const EXCLUDED_METADATA = new Set(["model", "prompt", "messages", "abortSignal"]);
const REASONING_MODELS = [/codex/i, /\bgpt-5/i, /\bo[1-9](?:-|$)/i, /\bdeepseek-r1/i, /\bqwq/i];
const MAX_RESPONSE_BODY_LENGTH = 2_000;

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

function isRetryableAbort(checked) {
  return checked.status === "error" && /request was aborted|请求超时/i.test(checked.message);
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
  const timeoutMs = options.timeoutMs ?? 45_000;
  const degradedMs = options.degradedMs ?? 10_000;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const checked = await checkProvider(config, options);
    if (!isRetryableAbort(checked) || attempt === 2) return checked;
  }
}

export async function checkAll(providers, options = {}) {
  const limit = pLimit(options.concurrency ?? 5);
  const check = options.checkProvider
    ? async (config) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const checked = await options.checkProvider(config, options);
          if (!isRetryableAbort(checked) || attempt === 2) return checked;
        }
      }
    : (config) => checkWithRetry(config, options);
  return Promise.all(providers.filter((item) => !item.isMaintenance).map((item) => limit(() => check(item))));
}
