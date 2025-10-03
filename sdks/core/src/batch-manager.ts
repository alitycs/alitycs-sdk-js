import type { AnalyticsEvent, BatchPayload, ResolvedConfig } from './types';
import type { HttpTransport } from './transport';
import type { Logger } from './logger';
import { generateId } from './utils';

export class BatchManager {
  private queue: AnalyticsEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(
    private config: ResolvedConfig,
    private transport: HttpTransport,
    private logger: Logger
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.queue.length > 0) this.flush();
    }, this.config.flushInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  add(event: AnalyticsEvent): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      this.logger.warn('Queue full — dropping event');
      return;
    }
    this.queue.push(event);

    if (this.queue.length >= this.config.flushSize) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;

    this.flushing = true;
    const events = this.queue.splice(0);

    try {
      const payload: BatchPayload = {
        batchId: `batch_${generateId()}`,
        sentAt: Date.now(),
        events,
      };
      await this.transport.send(payload);
    } catch {
      // Best-effort — events are dropped on final failure (transport already retried)
      this.logger.warn('Batch send failed — events dropped');
    } finally {
      this.flushing = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}
