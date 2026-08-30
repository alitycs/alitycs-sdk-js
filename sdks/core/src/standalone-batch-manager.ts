import type { AnalyticsEvent, BatchPayload, ResolvedConfig } from './types';
import type { HttpTransport, TransportResult } from './transport';
import type { Logger } from './logger';
import { generateId } from './utils';

export interface StandaloneFlushOptions {
  keepalive?: boolean;
  maxPayloadBytes?: number;
  maxRetries?: number;
}

export interface StandaloneFlushResult {
  status: 'drained' | 'partial';
  delivered: number;
  pending: number;
}

type PendingBatch = {
  payload: BatchPayload;
  state: 'pending' | 'in_flight';
};

const DELIVERED: TransportResult = { ok: true, transient: false };
const MAX_STALLED_DRAIN_ROUNDS = 3;

/**
 * Small, non-durable batcher used only by the size-constrained GA4 IIFE. The regular browser
 * entry uses BatchManager, which adds the diagnostics and persistence surfaces. This batcher
 * still preserves the batch identity on every retry and never silently drops transient failures.
 */
export class StandaloneBatchManager {
  private queue: AnalyticsEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingBatch: PendingBatch | null = null;
  private inFlightBatch: PendingBatch | null = null;
  private flushPromise: Promise<StandaloneFlushResult> | null = null;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly transport: HttpTransport,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending > 0) void this.flush();
    }, this.config.flushInterval);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  add(event: AnalyticsEvent): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      this.logger.warn('Queue full — dropping event');
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= this.config.flushSize) void this.flush();
  }

  flush(options: StandaloneFlushOptions = {}): Promise<StandaloneFlushResult> {
    if (this.flushPromise) {
      return options.keepalive === true
        ? this.sendKeepalive(options)
        : this.flushPromise.then(() => this.flush(options));
    }
    if (this.outstanding === 0) return Promise.resolve({ status: 'drained', delivered: 0, pending: 0 });

    const promise = this.flushOne(options);
    this.flushPromise = promise;
    void promise.finally(() => {
      if (this.flushPromise === promise) this.flushPromise = null;
    });
    return promise;
  }

  async drain(options: StandaloneFlushOptions = {}): Promise<StandaloneFlushResult> {
    let delivered = 0;
    let stalled = 0;
    while (this.outstanding > 0 || this.flushPromise) {
      const before = this.outstanding;
      const result = await this.flush(options);
      delivered += result.delivered;
      if (this.outstanding > 0 && result.delivered === 0 && this.outstanding >= before) {
        if (++stalled >= MAX_STALLED_DRAIN_ROUNDS) break;
      } else {
        stalled = 0;
      }
    }
    return this.result(delivered);
  }

  get pending(): number {
    return this.queue.length + (this.pendingBatch?.payload.events.length ?? 0);
  }

  private get outstanding(): number {
    return this.pending + (this.inFlightBatch?.payload.events.length ?? 0);
  }

  private async flushOne(options: StandaloneFlushOptions): Promise<StandaloneFlushResult> {
    const batch = this.takeBatch(options.maxPayloadBytes);
    if (!batch) return this.result(0);
    const delivered = await this.deliver(batch, options);
    return this.result(delivered);
  }

  private takeBatch(maxPayloadBytes?: number): PendingBatch | null {
    if (this.pendingBatch) {
      if (maxPayloadBytes && this.exceeds(this.pendingBatch.payload, maxPayloadBytes)) return null;
      const batch = this.pendingBatch;
      this.pendingBatch = null;
      batch.state = 'in_flight';
      this.inFlightBatch = batch;
      return batch;
    }
    if (this.queue.length === 0) return null;

    const sentAt = Date.now();
    const batchId = `batch_${generateId()}`;
    const events = this.selectEvents(batchId, sentAt, maxPayloadBytes);
    if (events.length === 0) return null;
    const batch: PendingBatch = {
      payload: { batchId, sentAt, events },
      state: 'in_flight',
    };
    this.queue.splice(0, events.length);
    this.inFlightBatch = batch;
    return batch;
  }

  private async deliver(batch: PendingBatch, options: StandaloneFlushOptions): Promise<number> {
    if (this.inFlightBatch !== batch) return 0;
    let result: TransportResult;
    try {
      result =
        (await this.transport.send(batch.payload, {
          keepalive: options.keepalive,
          maxRetries: options.maxRetries,
        })) ?? DELIVERED;
    } catch (error) {
      result = { ok: false, transient: true, message: error instanceof Error ? error.message : String(error) };
    }
    if (this.inFlightBatch !== batch) return 0;
    if (result.ok) {
      this.inFlightBatch = null;
      return batch.payload.events.length;
    }
    if (result.transient) {
      this.inFlightBatch = null;
      batch.state = 'pending';
      this.pendingBatch = batch;
      this.logger.warn(`Batch send failed — ${batch.payload.events.length} event(s) retained for retry`);
      return 0;
    }
    if ((result.status === 400 || result.status === 413) && batch.payload.events.length > 1) {
      this.inFlightBatch = null;
      const mid = batch.payload.events.length >> 1;
      const left = this.child(batch, 0, mid);
      const right = this.child(batch, mid, batch.payload.events.length);
      return (await this.deliverChild(left, options)) + (await this.deliverChild(right, options));
    }
    this.inFlightBatch = null;
    this.logger.warn(`Server rejected batch (HTTP ${result.status ?? 'unknown'}) — events dropped`);
    return 0;
  }

  private async sendKeepalive(options: StandaloneFlushOptions): Promise<StandaloneFlushResult> {
    const batch = this.inFlightBatch;
    if (!batch || (options.maxPayloadBytes && this.exceeds(batch.payload, options.maxPayloadBytes))) {
      return this.result(0);
    }
    let result: TransportResult;
    try {
      result =
        (await this.transport.send(batch.payload, {
          keepalive: true,
          maxRetries: options.maxRetries,
        })) ?? DELIVERED;
    } catch {
      return this.result(0);
    }
    if (result.ok && this.inFlightBatch === batch) {
      this.inFlightBatch = null;
      return this.result(batch.payload.events.length);
    }
    return this.result(0);
  }

  private deliverChild(batch: PendingBatch, options: StandaloneFlushOptions): Promise<number> {
    this.inFlightBatch = batch;
    return this.deliver(batch, options);
  }

  private child(parent: PendingBatch, start: number, end: number): PendingBatch {
    return {
      state: 'in_flight',
      payload: {
        batchId: `batch_${generateId()}`,
        sentAt: parent.payload.sentAt,
        events: parent.payload.events.slice(start, end),
      },
    };
  }

  private selectEvents(batchId: string, sentAt: number, maxPayloadBytes?: number): AnalyticsEvent[] {
    if (!maxPayloadBytes) return [...this.queue];
    const selected: AnalyticsEvent[] = [];
    for (const event of this.queue) {
      const events = [...selected, event];
      if (!this.exceeds({ batchId, sentAt, events }, maxPayloadBytes)) selected.push(event);
      else break;
    }
    return selected;
  }

  private exceeds(payload: BatchPayload, maxPayloadBytes: number): boolean {
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxPayloadBytes;
  }

  private result(delivered: number): StandaloneFlushResult {
    return {
      status: this.outstanding === 0 ? 'drained' : 'partial',
      delivered,
      pending: this.outstanding,
    };
  }
}
