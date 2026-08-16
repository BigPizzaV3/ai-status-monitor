export function createNotifierGroup(entries = []) {
  const active = entries.filter(({ notifier }) => notifier?.enabled);
  if (!active.length) {
    return {
      enabled: false,
      async send() { return false; }
    };
  }

  return {
    enabled: true,
    async send(message) {
      const results = await Promise.allSettled(active.map(({ notifier }) => notifier.send(message)));
      let delivered = 0;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          delivered += 1;
          return;
        }
        const name = active[index].name || `notifier-${index + 1}`;
        console.error(`[ai-status-monitor] ${name} notification failed: ${result.reason?.message || "unknown error"}`);
      });
      if (!delivered) throw new Error("all configured notification channels failed");
      return true;
    }
  };
}
