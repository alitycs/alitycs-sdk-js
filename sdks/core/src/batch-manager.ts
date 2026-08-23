import type { AnalyticsEvent, BatchPayload, ResolvedConfig } from './types';
import type { HttpTransport } from './transport';
import type { Logger } from './logger';
import { generateId } from './utils';

export interface BatchFlushOptions {
  keepalive?: boolean;
  maxPayloadBytes?: number;
  maxRetries?: number;
}

export class BatchManager {
  private queue: AnalyticsEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private inFlightEvents: AnalyticsEvent[] = [];

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

  async flush(options: BatchFlushOptions = {}): Promise<void> {
    const ownsFlushLock = !this.flushing;
    if (!ownsFlushLock && options.keepalive !== true) return;
    const replayEvents = !ownsFlushLock && options.keepalive === true ? this.inFlightEvents : [];
    if (this.queue.length === 0 && replayEvents.length === 0) return;

    if (ownsFlushLock) this.flushing = true;
    const batchId = `batch_${generateId()}`;
    const sentAt = Date.now();
    const events = this.takeEvents(batchId, sentAt, options.maxPayloadBytes, replayEvents);

    if (events.length === 0) {
      if (ownsFlushLock) this.flushing = false;
      return;
    }
    if (ownsFlushLock) this.inFlightEvents = events;

    try {
      const payload: BatchPayload = {
        batchId,
        sentAt,
        events,
      };
      await this.transport.send(payload, {
        keepalive: options.keepalive,
        maxRetries: options.maxRetries,
      });
    } catch {
      // Best-effort — events are dropped on final failure (transport already retried)
      this.logger.warn('Batch send failed — events dropped');
    } finally {
      if (ownsFlushLock) {
        this.inFlightEvents = [];
        this.flushing = false;
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private takeEvents(
    batchId: string,
    sentAt: number,
    maxPayloadBytes?: number,
    replayEvents: AnalyticsEvent[] = []
  ): AnalyticsEvent[] {
    if (!maxPayloadBytes) return [...this.queue.splice(0), ...replayEvents];

    const selected: AnalyticsEvent[] = [];
    while (this.queue.length > 0) {
      const candidate = this.queue[0];
      const candidatePayload: BatchPayload = {
        batchId,
        sentAt,
        events: [...selected, candidate],
      };
      const byteLength = new TextEncoder().encode(JSON.stringify(candidatePayload)).byteLength;

      if (byteLength <= maxPayloadBytes) {
        selected.push(this.queue.shift()!);
        continue;
      }

      if (selected.length === 0) {
        this.queue.shift();
        this.logger.warn('Event exceeds keepalive payload limit — dropping event');
        continue;
      }

      break;
    }

    if (this.queue.length === 0) {
      for (const candidate of replayEvents) {
        const candidatePayload: BatchPayload = {
          batchId,
          sentAt,
          events: [...selected, candidate],
        };
        const byteLength = new TextEncoder().encode(JSON.stringify(candidatePayload)).byteLength;

        if (byteLength <= maxPayloadBytes) {
          selected.push(candidate);
          continue;
        }

        if (selected.length === 0) {
          this.logger.warn('In-flight event exceeds keepalive payload limit — replay skipped');
          continue;
        }

        break;
      }
    }

    return selected;
  }
}
