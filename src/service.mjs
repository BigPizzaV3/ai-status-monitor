const FAILURE_STATUSES = new Set(["failed", "validation_failed", "error"]);
const HEALTHY_STATUSES = new Set(["operational", "degraded"]);

export class CheckerService {
  constructor({ providers, store, checkAll, intervalMs, concurrency, timeoutMs, degradedMs, apiHistoryPoints = 91, alertNotifier = null, alertConsecutiveFailures = 3, now = () => new Date() }) {
    this.providers = providers;
    this.store = store;
    this.checkAll = checkAll;
    this.intervalMs = intervalMs;
    this.options = { concurrency, timeoutMs, degradedMs };
    this.apiHistoryPoints = apiHistoryPoints;
    this.alertNotifier = alertNotifier;
    this.alertConsecutiveFailures = Math.max(1, alertConsecutiveFailures);
    this.now = now;
    this.alertStates = new Map();
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
        await this.updateAlerts(results);
        this.lastCompletedAt = new Date().toISOString();
        return results;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async updateAlerts(results) {
    if (!this.alertNotifier?.enabled) return;
    for (const result of results) {
      const state = this.alertStates.get(result.id) || { consecutiveFailures: 0, failureAlertSent: false };
      if (FAILURE_STATUSES.has(result.status)) {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= this.alertConsecutiveFailures && !state.failureAlertSent) {
          try {
            await this.alertNotifier.send({
              subject: `[状态监控] ${result.name} 连续检测失败`,
              text: formatFailureEmail(result, state.consecutiveFailures, this.now())
            });
            state.failureAlertSent = true;
          } catch (error) {
            console.error(`[ai-status-monitor] failed to send alert for ${result.id}: ${error.message}`);
          }
        }
      } else if (HEALTHY_STATUSES.has(result.status)) {
        if (state.failureAlertSent) {
          try {
            await this.alertNotifier.send({
              subject: `[状态监控] ${result.name} 已恢复`,
              text: formatRecoveryEmail(result, state.consecutiveFailures, this.now())
            });
          } catch (error) {
            console.error(`[ai-status-monitor] failed to send recovery for ${result.id}: ${error.message}`);
          }
        }
        state.consecutiveFailures = 0;
        state.failureAlertSent = false;
      }
      this.alertStates.set(result.id, state);
    }
  }

  historySummary({ hours = 24, trendPoints = 16 } = {}) {
    const safeHours = Math.min(30 * 24, Math.max(1, Number(hours) || 24));
    const to = this.now();
    const from = new Date(to.getTime() - safeHours * 3_600_000);
    const providers = this.providers.map((config) => {
      const points = this.store.points(config.id).filter((point) => Date.parse(point.checkedAt) >= from.getTime());
      const successful = points.filter((point) => HEALTHY_STATUSES.has(point.status));
      const failedChecks = points.filter((point) => FAILURE_STATUSES.has(point.status)).length;
      const latencies = points.map((point) => point.latencyMs).filter(Number.isFinite);
      return {
        id: config.id,
        name: config.name,
        model: config.model,
        totalChecks: points.length,
        failedChecks,
        successRate: points.length ? Math.round(successful.length / points.length * 10_000) / 100 : 0,
        avgLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
        maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
        trend: points.slice(-trendPoints).map((point) => point.status)
      };
    });
    return { hours: safeHours, from: from.toISOString(), to: to.toISOString(), providers };
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

function formatFailureEmail(result, consecutiveFailures, checkedAt) {
  return [
    "状态监控检测到渠道连续失败。",
    "",
    `渠道: ${result.name}`,
    `模型: ${result.model || "-"}`,
    `状态: ${result.status}`,
    `连续失败次数: ${consecutiveFailures}`,
    `检测时间: ${checkedAt.toISOString()}`,
    `错误信息: ${result.message || "-"}`,
    result.endpoint ? `端点: ${result.endpoint}` : null
  ].filter(Boolean).join("\n");
}

function formatRecoveryEmail(result, previousFailures, checkedAt) {
  return [
    "状态监控检测到渠道已恢复。",
    "",
    `渠道: ${result.name}`,
    `模型: ${result.model || "-"}`,
    `当前状态: ${result.status}`,
    `恢复前连续失败次数: ${previousFailures}`,
    `检测时间: ${checkedAt.toISOString()}`,
    `当前信息: ${result.message || "-"}`
  ].join("\n");
}

function formatInterval(intervalMs) {
  const seconds = intervalMs / 1000;
  if (Number.isInteger(seconds / 60)) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}
