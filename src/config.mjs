import fs from "node:fs/promises";

const TYPES = new Set(["openai", "anthropic", "gemini"]);
const CHECK_MODES = new Set(["challenge", "simple"]);

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
  const simplePrompt = item.simplePrompt || item.simple_prompt || "hi";
  if (typeof simplePrompt !== "string" || !simplePrompt.trim()) {
    throw new Error(`Provider ${item.name} has an invalid simplePrompt`);
  }
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
    simplePrompt: simplePrompt.trim()
  };
}

export async function loadConfig(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Provider configuration must be an array");
  const providers = parsed.map(normalizeProvider).filter((item) => item.enabled);
  if (!providers.length) throw new Error("No enabled providers configured");
  return providers;
}
