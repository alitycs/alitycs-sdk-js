const MAX_ENTRIES = 10_000;
const CLEANUP_INTERVAL = 100;

export class EventDeduplicator {
  private entries = new Map<string, { expiresAt: number }>();
  private callCount = 0;

  isDuplicate(dedupeKey: string, windowMs: number): boolean {
    this.callCount++;
    if (this.callCount % CLEANUP_INTERVAL === 0) {
      this.cleanup();
    }

    const now = Date.now();
    const existing = this.entries.get(dedupeKey);

    if (existing && existing.expiresAt > now) {
      return true;
    }

    this.entries.set(dedupeKey, { expiresAt: now + windowMs });

    if (this.entries.size > MAX_ENTRIES) {
      this.evict();
    }

    return false;
  }

  clear(): void {
    this.entries.clear();
    this.callCount = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private evict(): void {
    const toRemove = Math.ceil(MAX_ENTRIES * 0.1);
    const iterator = this.entries.keys();
    for (let i = 0; i < toRemove; i++) {
      const next = iterator.next();
      if (next.done) break;
      this.entries.delete(next.value);
    }
  }
}
