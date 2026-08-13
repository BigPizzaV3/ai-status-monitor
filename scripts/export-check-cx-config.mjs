import fs from "node:fs/promises";

const output = process.argv[2] || "/tmp/ai-status-monitor-providers.json";
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase service environment");

const fields = [
  "id",
  "name",
  "type",
  "endpoint",
  "api_key",
  "is_maintenance",
  "group_name",
  "check_models(id,type,model,template_id,check_request_templates(type,request_header,metadata))"
].join(",");
const endpoint = new URL("/rest/v1/check_configs", url);
endpoint.searchParams.set("select", fields);
endpoint.searchParams.set("enabled", "eq.true");
endpoint.searchParams.set("order", "id.asc");

const response = await fetch(endpoint, {
  headers: { apikey: key, authorization: `Bearer ${key}` }
});
if (!response.ok) throw new Error(`Supabase returned HTTP ${response.status}`);
const rows = await response.json();

function one(value) {
  return Array.isArray(value) ? value[0] : value;
}

const providers = rows.map((row) => {
  const model = one(row.check_models);
  const template = one(model?.check_request_templates);
  if (!model?.model) throw new Error(`Provider ${row.name} has no model`);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    endpoint: row.endpoint,
    model: model.model,
    apiKey: row.api_key,
    checkMode: "challenge",
    simplePrompt: "hi",
    enabled: true,
    isMaintenance: row.is_maintenance === true,
    requestHeaders: template?.request_header || null,
    metadata: template?.metadata || null,
    groupName: row.group_name || null
  };
});

await fs.writeFile(output, `${JSON.stringify(providers, null, 2)}\n`, { mode: 0o600 });
await fs.chmod(output, 0o600);
console.log(JSON.stringify({ count: providers.length, names: providers.map(({ name }) => name) }));
