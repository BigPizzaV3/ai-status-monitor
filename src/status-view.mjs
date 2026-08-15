const HEALTHY_STATUSES = new Set(["operational", "degraded"]);
const FAILED_STATUSES = new Set(["failed", "validation_failed", "error"]);

export function transformStatus(source) {
  const providers = Array.isArray(source.providers) ? source.providers : [];
  const components = providers.map((provider) => {
    const timeline = Array.isArray(provider.timeline) ? [...provider.timeline].reverse() : [];
    const latest = provider.latest || null;
    return {
      id: provider.id,
      name: provider.name,
      description: `${provider.model} · ${providerLabel(provider.type)}`,
      model: provider.model,
      providerType: provider.type,
      latest: latest ? {
        status: latest.status,
        ok: HEALTHY_STATUSES.has(latest.status),
        latencyMs: latest.latencyMs,
        pingLatencyMs: latest.pingLatencyMs,
        checkedAt: latest.checkedAt,
        message: latest.message
      } : null,
      uptime: provider.statistics?.successRate ?? null,
      checks: provider.statistics?.totalChecks ?? timeline.length,
      points: timeline.map((point) => ({
        at: point.checkedAt,
        status: point.status,
        ok: HEALTHY_STATUSES.has(point.status),
        latencyMs: point.latencyMs,
        pingLatencyMs: point.pingLatencyMs,
        message: point.message
      }))
    };
  });

  const hasFailure = components.some((item) => item.latest && FAILED_STATUSES.has(item.latest.status));
  const hasDegraded = components.some((item) => item.latest?.status === "degraded");
  return {
    ok: true,
    checkedAt: components.reduce((latest, item) => {
      if (!item.latest?.checkedAt) return latest;
      return !latest || new Date(item.latest.checkedAt) > new Date(latest) ? item.latest.checkedAt : latest;
    }, null),
    overall: hasFailure ? "outage" : hasDegraded ? "degraded" : "operational",
    pollIntervalMs: source.metadata?.pollIntervalMs || null,
    pollIntervalLabel: source.metadata?.pollIntervalLabel || "-",
    history: {
      page: source.metadata?.historyPage || 0,
      pageSize: source.metadata?.historyPageSize || 0,
      hasOlder: source.metadata?.hasOlderHistory === true,
      hasNewer: source.metadata?.hasNewerHistory === true
    },
    summary: source.summary || {},
    components,
    incidents: components
      .filter((item) => item.latest && item.latest.status !== "operational")
      .map((item) => ({
        componentId: item.id,
        componentName: item.name,
        at: item.latest.checkedAt,
        status: item.latest.status,
        message: item.latest.message,
        latencyMs: item.latest.latencyMs
      }))
      .sort((a, b) => new Date(b.at) - new Date(a.at))
  };
}

function providerLabel(type) {
  return { openai: "OpenAI 协议", anthropic: "Anthropic 协议", gemini: "Gemini 协议" }[type] || type;
}
