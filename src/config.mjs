import fs from "node:fs/promises";

const TYPES = new Set(["openai", "anthropic", "gemini"]);
const CHECK_MODES = new Set(["challenge", "simple", "image", "claude-code"]);
const DEFAULT_IMAGE_PROMPT = "一只拉布拉多犬一直用前爪举着一块牌子，牌子上写着 \"JOJO Code\"";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const IMAGE_SIZE_PATTERN = /^\d{2,4}x\d{2,4}$/;
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 24 * 3600;

function optionalNumber(item, keys, { fallback = null, min, max, label }) {
  for (const key of keys) {
    const raw = item[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(label);
    return value;
  }
  return fallback;
}

function normalizeProvider(item, index) {
  if (!item || typeof item !== "object") throw new Error(`Provider ${index + 1} must be an object`);
  for (const field of ["id", "name", "type", "endpoint", "model", "apiKey"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      throw new Error(`Provider ${index + 1} is missing ${field}`);
    }
  }
  if (!TYPES.has(item.type)) throw new Error(`Provider ${item.name} has unsupported type ${item.type}`);
  const checkMode = item.checkMode || item.check_mode || "challenge";
  if (!CHECK_MODES.has(checkMode)) throw new Error(`Provider ${item.name} has unsupported checkMode ${checkMode}`);
  // Claude Code 伪装检测依赖 anthropic 的 /v1/messages 协议。
  if (checkMode === "claude-code" && item.type !== "anthropic") {
    throw new Error(`Provider ${item.name} checkMode claude-code requires type anthropic`);
  }
  const isImage = checkMode === "image";
  const promptInput = item.simplePrompt ?? item.simple_prompt;
  const simplePrompt = String(promptInput || (isImage ? DEFAULT_IMAGE_PROMPT : "hi")).trim();
  if (!simplePrompt) {
    throw new Error(`Provider ${item.name} has an invalid simplePrompt`);
  }
  const imagePrompt = String(item.imagePrompt || item.image_prompt || simplePrompt).trim();
  const imageSize = String(item.imageSize || item.image_size || DEFAULT_IMAGE_SIZE).trim();
  if (isImage && !IMAGE_SIZE_PATTERN.test(imageSize)) {
    throw new Error(`Provider ${item.name} has an invalid imageSize ${imageSize}`);
  }
  const intervalSeconds = optionalNumber(item, ["intervalSeconds", "interval_seconds"], {
    min: MIN_INTERVAL_SECONDS,
    max: MAX_INTERVAL_SECONDS,
    label: `Provider ${item.name} has an invalid intervalSeconds (${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS})`
  });
  const degradedMs = optionalNumber(item, ["degradedMs", "degraded_ms"], {
    min: 1000,
    max: 600_000,
    label: `Provider ${item.name} has an invalid degradedMs`
  });
  const timeoutMs = optionalNumber(item, ["timeoutMs", "timeout_ms"], {
    min: 2000,
    max: 900_000,
    label: `Provider ${item.name} has an invalid timeoutMs`
  });
  new URL(item.endpoint);
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    endpoint: item.endpoint,
    model: item.model,
    apiKey: item.apiKey,
    enabled: item.enabled !== false,
    isMaintenance: item.isMaintenance === true || item.is_maintenance === true,
    requestHeaders: item.requestHeaders || null,
    metadata: item.metadata || null,
    groupName: item.groupName || item.group_name || null,
    checkMode,
    kind: isImage ? "image" : "text",
    simplePrompt,
    imagePrompt,
    imageSize,
    // Image generation is slow: fall back to a longer timeout and a looser
    // degraded threshold unless the provider overrides them explicitly.
    intervalMs: intervalSeconds === null ? null : intervalSeconds * 1000,
    degradedMs: degradedMs ?? (isImage ? 120_000 : null),
    timeoutMs: timeoutMs ?? (isImage ? 240_000 : null)
  };
}

export async function loadConfig(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Provider configuration must be an array");
  const providers = parsed.map(normalizeProvider).filter((item) => item.enabled);
  if (!providers.length) throw new Error("No enabled providers configured");
  return providers;
}
