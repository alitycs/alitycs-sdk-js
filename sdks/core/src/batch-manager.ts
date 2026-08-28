import type { AnalyticsEvent, ResolvedConfig } from './types';
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
  private inFlightEvents: AnalyticsEvent[] = [];
  private flushPromise: Promise<void> | null = null;
  private keepalivePromises = new Set<Promise<void>>();

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

  flush(options: BatchFlushOptions = {}): Promise<void> {
    const inFlight = this.flushPromise;
    if (inFlight) {
      // While a send is in flight, wait for it and then flush what was queued meanwhile.
      // Concurrent callers chain onto the same promise, so one follow-up flush serves them all.
      if (options.keepalive !== true) return inFlight.then(() => this.flush(options));
      // Page-exit keepalive replays the unresolved batch immediately, without waiting;
      // sendBatch no-ops when neither queued nor unresolved events remain.
      const keepalive = this.sendBatch(options, this.inFlightEvents);
      const tracked = keepalive.finally(() => this.keepalivePromises.delete(tracked));
      this.keepalivePromises.add(tracked);
      return tracked;
    }
    if (this.queue.length === 0) return Promise.resolve();

    const send = this.sendBatch(options, undefined, true);
    // Cleanup belongs to the wrapper created here, after flushPromise is assigned. If
    // sendBatch completes synchronously (for example, all events exceed a payload bound),
    // its finally callback still runs in a later microtask and cannot leave a stale promise.
    const tracked = send.finally(() => {
      if (this.flushPromise === tracked) {
        this.flushPromise = null;
        this.inFlightEvents = [];
      }
    });
    this.flushPromise = tracked;
    return tracked;
  }

  /** Resolves only once nothing is queued and no send is in flight; used by shutdown(). */
  async drain(options: BatchFlushOptions = {}): Promise<void> {
    while (this.pending > 0 || this.flushPromise || this.keepalivePromises.size > 0) {
      if (this.pending > 0 || this.flushPromise) await this.flush(options);
      if (this.keepalivePromises.size > 0) {
        await Promise.all([...this.keepalivePromises]);
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private async sendBatch(
    options: BatchFlushOptions,
    replayEvents?: AnalyticsEvent[],
    ownsInFlight?: boolean
  ): Promise<void> {
    const batchId = `batch_${generateId()}`;
    const sentAt = Date.now();
    const replay = replayEvents ?? [];
    const events = this.takeEvents(batchId, sentAt, options.maxPayloadBytes, replay);

    if (events.length > 0) {
      // Only the send that owns the in-flight slot tracks its batch for keepalive replay.
      if (ownsInFlight) this.inFlightEvents = events;
      try {
        await this.transport.send(
          { batchId, sentAt, events },
          {
            keepalive: options.keepalive,
            maxRetries: options.maxRetries,
          }
        );
      } catch {
        // Best-effort — events are dropped on final failure (transport already retried)
        this.logger.warn('Batch send failed — events dropped');
      }
    }
  }

  private takeEvents(
    batchId: string,
    sentAt: number,
    maxPayloadBytes?: number,
    replayEvents: AnalyticsEvent[] = []
  ): AnalyticsEvent[] {
    if (!maxPayloadBytes) return [...this.queue.splice(0), ...replayEvents];

    const exceedsLimit = (events: AnalyticsEvent[]): boolean =>
      new TextEncoder().encode(JSON.stringify({ batchId, sentAt, events })).byteLength > maxPayloadBytes;

    const selected: AnalyticsEvent[] = [];
    while (this.queue.length > 0) {
      const candidate = this.queue[0];

      if (!exceedsLimit([...selected, candidate])) {
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
        if (!exceedsLimit([...selected, candidate])) {
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
