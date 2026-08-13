import fs from "node:fs/promises";
import path from "node:path";

export class HistoryStore {
  constructor(filePath, retentionDays = 30) {
    this.filePath = filePath;
    this.retentionMs = retentionDays * 86_400_000;
    this.history = {};
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.history = parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.prune();
    await this.persist();
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    for (const [id, points] of Object.entries(this.history)) {
      this.history[id] = Array.isArray(points)
        ? points.filter((point) => Date.parse(point.checkedAt) >= cutoff)
        : [];
    }
  }

  async append(results) {
    for (const result of results) {
      (this.history[result.id] ||= []).push(result);
    }
    this.prune();
    await this.persist();
  }

  async persist() {
    const snapshot = JSON.stringify(this.history);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    });
    await this.writeQueue;
  }

  points(id) {
    return this.history[id] || [];
  }
}
