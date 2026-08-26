import type { AnalyticsEvent, ResolvedConfig } from './types';
import type { HttpTransport, TransportResult } from './transport';
import type { Logger } from './logger';
import { generateId } from './utils';

export interface BatchFlushOptions {
  keepalive?: boolean;
  maxPayloadBytes?: number;
  maxRetries?: number;
}

/** Maximum halvings when the server rejects a batch wholesale (HTTP 400). */
const MAX_SPLIT_DEPTH = 5;

/** How many flush rounds drain() tolerates without progress before dropping the remainder. */
const MAX_STALLED_DRAIN_ROUNDS = 3;

/** Transports predating outcome results return void; treat that as delivered. */
const DELIVERED: TransportResult = { ok: true, transient: false };

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

  /**
   * Resolves once nothing is queued and no send is in flight; used by shutdown().
   * A flush round that requeues everything after a failure makes no progress, so after
   * MAX_STALLED_DRAIN_ROUNDS such rounds the remainder is dropped instead of looping forever.
   */
  async drain(options: BatchFlushOptions = {}): Promise<void> {
    let stalledRounds = 0;
    while (this.pending > 0 || this.flushPromise || this.keepalivePromises.size > 0) {
      const outstanding = this.pending;
      if (outstanding > 0 || this.flushPromise) await this.flush(options);
      if (this.keepalivePromises.size > 0) {
        await Promise.all([...this.keepalivePromises]);
      }
      if (outstanding > 0 && this.pending >= outstanding) {
        if (++stalledRounds >= MAX_STALLED_DRAIN_ROUNDS) {
          this.logger.warn(`Dropping ${this.pending} event(s) after repeated send failures`);
          this.queue.length = 0;
          break;
        }
      } else {
        stalledRounds = 0;
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
    const sentAt = Date.now();
    const replay = replayEvents ?? [];
    const events = this.takeEvents(`batch_${generateId()}`, sentAt, options.maxPayloadBytes, replay);

    if (events.length > 0) {
      // Only the send that owns the in-flight slot tracks its batch for keepalive replay.
      if (ownsInFlight) this.inFlightEvents = events;
      const undelivered = await this.deliver(events, options, sentAt, MAX_SPLIT_DEPTH);
      if (undelivered.length > 0) this.requeue(undelivered);
    }
  }

  /**
   * Sends one batch. Returns the events that should be kept for a later flush:
   * transient failures requeue everything; a whole-batch HTTP 400 is split in half
   * recursively to isolate bad events (bounded by depth); other rejections are dropped.
   */
  private async deliver(
    events: AnalyticsEvent[],
    options: BatchFlushOptions,
    sentAt: number,
    depth: number
  ): Promise<AnalyticsEvent[]> {
    if (events.length === 0) return [];

    let result: TransportResult;
    try {
      result =
        (await this.transport.send(
          { batchId: `batch_${generateId()}`, sentAt, events },
          { keepalive: options.keepalive, maxRetries: options.maxRetries }
        )) ?? DELIVERED;
    } catch {
      result = { ok: false, transient: true };
    }

    if (result.ok) return [];

    if (result.transient) {
      this.logger.warn(`Batch send failed — ${events.length} event(s) requeued`);
      return events;
    }

    if (result.status === 400 && depth > 0 && events.length > 1) {
      const mid = events.length >> 1;
      const left = await this.deliver(events.slice(0, mid), options, sentAt, depth - 1);
      const right = await this.deliver(events.slice(mid), options, sentAt, depth - 1);
      return [...left, ...right];
    }

    this.logger.warn(`Server rejected batch (HTTP ${result.status ?? 'unknown'}) — ${events.length} event(s) dropped`);
    return [];
  }

  /** Puts undelivered events back at the head of the queue, preserving their order. */
  private requeue(events: AnalyticsEvent[]): void {
    this.queue.unshift(...events);
    const overflow = this.queue.length - this.config.maxQueueSize;
    if (overflow > 0) {
      this.queue.length = this.config.maxQueueSize;
      this.logger.warn(`Queue overflow after failed batch — ${overflow} event(s) dropped`);
    }
  }

  private takeEvents(
    batchId: string,
    sentAt: number,
    maxPayloadBytes?: number,
    replayEvents: AnalyticsEvent[] = []
  ): AnalyticsEvent[] {
    if (!maxPayloadBytes) return [...replayEvents, ...this.queue.splice(0)];

    const exceedsLimit = (events: AnalyticsEvent[]): boolean =>
      new TextEncoder().encode(JSON.stringify({ batchId, sentAt, events })).byteLength > maxPayloadBytes;

    const selected: AnalyticsEvent[] = [];
    for (const candidate of replayEvents) {
      if (!exceedsLimit([...selected, candidate])) {
        selected.push(candidate);
        continue;
      }

      if (selected.length === 0) {
        this.logger.warn('In-flight event exceeds keepalive payload limit — replay skipped');
        continue;
      }

      return selected;
    }

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

    return selected;
  }
}
