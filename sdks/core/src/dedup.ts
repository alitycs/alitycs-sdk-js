const MAX_ENTRIES = 10_000;
const CLEANUP_INTERVAL = 100;

export class EventDeduplicator {
  private entries: Map<string, { expiresAt: number }>;
  private callCount: number;

  constructor() {
    this.entries = new Map();
    this.callCount = 0;
  }

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
    let toRemove = Math.ceil(MAX_ENTRIES * 0.1);
    while (toRemove > 0 && this.entries.size > 0) {
      this.entries.delete(this.entries.keys().next().value!);
      toRemove--;
    }
  }
}
