export class CheckerService {
  constructor({ providers, store, checkAll, intervalMs, concurrency, timeoutMs, degradedMs, apiHistoryPoints = 91 }) {
    this.providers = providers;
    this.store = store;
    this.checkAll = checkAll;
    this.intervalMs = intervalMs;
    this.options = { concurrency, timeoutMs, degradedMs };
    this.apiHistoryPoints = apiHistoryPoints;
    this.running = null;
    this.timer = null;
    this.lastCompletedAt = null;
  }

  start() {
    this.run().catch((error) => console.error("[ai-status-monitor] initial check failed", error));
    this.timer = setInterval(() => this.run().catch((error) => console.error("[ai-status-monitor] scheduled check failed", error)), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  run() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const results = await this.checkAll(this.providers, this.options);
        await this.store.append(results);
        this.lastCompletedAt = new Date().toISOString();
        return results;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  status({ historyPage = 0 } = {}) {
    const page = Number.isInteger(historyPage) && historyPage > 0 ? historyPage : 0;
    const pageOffset = page * this.apiHistoryPoints;
    let hasOlderHistory = false;
    const providers = this.providers.map((config) => {
      const all = this.store.points(config.id);
      const pageEnd = Math.max(0, all.length - pageOffset);
      const pageStart = Math.max(0, pageEnd - this.apiHistoryPoints);
      const items = all.slice(pageStart, pageEnd).reverse();
      const current = all.at(-1) || null;
      hasOlderHistory ||= pageStart > 0;
      const latest = config.isMaintenance
        ? { ...(current || { checkedAt: new Date().toISOString(), latencyMs: null, pingLatencyMs: null, message: "维护中" }), status: "maintenance" }
        : current;
      const counts = { operational: 0, degraded: 0, failed: 0, validation_failed: 0, error: 0 };
      const latencies = [];
      for (const item of all) {
        if (item.status in counts) counts[item.status] += 1;
        if (Number.isFinite(item.latencyMs)) latencies.push(item.latencyMs);
      }
      const successes = counts.operational + counts.degraded;
      return {
        id: config.id,
        name: config.name,
        type: config.type,
        model: config.model,
        group: config.groupName,
        endpoint: config.endpoint,
        latest,
        statistics: {
          totalChecks: all.length,
          operationalCount: counts.operational,
          degradedCount: counts.degraded,
          failedCount: counts.failed + counts.error,
          validationFailedCount: counts.validation_failed,
          successRate: all.length ? Math.round(successes / all.length * 10_000) / 100 : 0,
          avgLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
          minLatencyMs: latencies.length ? Math.min(...latencies) : null,
          maxLatencyMs: latencies.length ? Math.max(...latencies) : null
        },
        timeline: items.map(({ status, latencyMs, pingLatencyMs, checkedAt, message }) => ({ status, latencyMs, pingLatencyMs, checkedAt, message }))
      };
    });
    const summary = { total: providers.length, operational: 0, degraded: 0, failed: 0, validationFailed: 0, maintenance: 0, avgLatencyMs: null };
    const latestLatencies = [];
    for (const provider of providers) {
      const status = provider.latest?.status;
      if (status === "operational") summary.operational += 1;
      else if (status === "degraded") summary.degraded += 1;
      else if (status === "validation_failed") summary.validationFailed += 1;
      else if (status === "maintenance") summary.maintenance += 1;
      else if (status) summary.failed += 1;
      if (Number.isFinite(provider.latest?.latencyMs)) latestLatencies.push(provider.latest.latencyMs);
    }
    summary.avgLatencyMs = latestLatencies.length ? Math.round(latestLatencies.reduce((sum, value) => sum + value, 0) / latestLatencies.length) : null;
    return {
      providers,
      summary,
      metadata: {
        generatedAt: new Date().toISOString(),
        pollIntervalMs: this.intervalMs,
        pollIntervalLabel: formatInterval(this.intervalMs),
        lastCompletedAt: this.lastCompletedAt,
        historyPage: page,
        historyPageSize: this.apiHistoryPoints,
        hasOlderHistory,
        hasNewerHistory: page > 0
      }
    };
  }
}

function formatInterval(intervalMs) {
  const seconds = intervalMs / 1000;
  if (Number.isInteger(seconds / 60)) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}
