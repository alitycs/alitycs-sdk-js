import type { AnalyticsEvent, DeliveryError, DeliveryStats, ResolvedConfig } from './types';
import type { HttpTransport, TransportResult } from './transport';
import type { Logger } from './logger';
import { DiagnosticsHub } from './diagnostics';
import { EventPersistence, type PersistedBatch, type PersistedQueuedEvent } from './persistence';
import { generateId } from './utils';

export interface BatchFlushOptions {
  keepalive?: boolean;
  maxPayloadBytes?: number;
  maxRetries?: number;
  /** Try one delivery even when the server-directed pause deadline has not elapsed. */
  force?: boolean;
}

export type FlushStatus = 'drained' | 'partial' | 'paused';

export interface FlushResult {
  status: FlushStatus;
  delivered: number;
  pending: number;
  pausedUntil?: number;
}

export type QuarantineReason = 'rejected_400' | 'payload_too_large' | 'invalid_event' | 'drain_gave_up';

export interface QuarantinedEvent {
  event: AnalyticsEvent;
  reason: QuarantineReason;
  at: number;
  status?: number;
  batchId?: string;
  message?: string;
}

interface QueuedEvent {
  event: AnalyticsEvent;
  enqueuedAt: number;
  seq: number;
}

interface PendingBatch extends PersistedBatch {
  state: 'pending' | 'in_flight' | 'acked' | 'discarded';
}

interface FlushWorkResult {
  delivered: number;
  attempted: boolean;
}

const MAX_STALLED_DRAIN_ROUNDS = 3;
const MAX_QUARANTINED_EVENTS = 100;
const DELIVERED: TransportResult = { ok: true, transient: false };

export class BatchManager {
  private queue: QueuedEvent[] = [];
  private queueHead = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlightBatch: PendingBatch | null = null;
  private flushPromise: Promise<FlushResult> | null = null;
  private keepalivePromises = new Set<Promise<FlushResult>>();
  private pendingBatches: PendingBatch[] = [];
  private pausedUntil: number | undefined;
  private nextSeq = 1;
  private readonly diagnostics: DiagnosticsHub;
  private readonly persistence: EventPersistence;
  private quarantined: QuarantinedEvent[] = [];
  private counters = {
    delivered: 0,
    failedDeliveries: 0,
    requeued: 0,
    retries: 0,
    rateLimited: 0,
    acceptedQuotaExceeded: 0,
    droppedOverflow: 0,
    droppedInvalid: 0,
    droppedRejected: 0,
    droppedDrainGiveUp: 0,
    droppedTotal: 0,
    deduplicated: 0,
    restoredFromStorage: 0,
    poisonIsolated: 0,
  };
  private lastError: DeliveryError | null = null;

  constructor(
    private config: ResolvedConfig,
    private transport: HttpTransport,
    private logger: Logger,
    diagnostics?: DiagnosticsHub,
    private readonly onStateChange?: () => void
  ) {
    this.diagnostics = diagnostics ?? new DiagnosticsHub(config.onDiagnostics, logger);
    this.persistence = new EventPersistence(
      config.persistence,
      config.endpoint,
      config.apiKey,
      Date.now,
      (message, error) => {
        this.diagnostics.emit({
          code: 'storage_error',
          level: 'error',
          message,
          details: error === undefined ? undefined : { error: String(error) },
        });
      }
    );

    const restored = this.persistence.load();
    this.nextSeq = restored.nextSeq;
    this.pausedUntil = restored.pausedUntil;
    if (restored.truncatedEvents > 0) {
      this.counters.droppedOverflow += restored.truncatedEvents;
      this.counters.droppedTotal += restored.truncatedEvents;
      this.diagnostics.emit({
        code: 'queue_overflow',
        message: `Persistence restore exceeded maxRestoredEvents; dropped ${restored.truncatedEvents} event(s)`,
        affectedEvents: restored.truncatedEvents,
        details: {
          policy: config.overflowPolicy ?? 'drop-newest',
          maxRestoredEvents:
            config.persistence && typeof config.persistence === 'object'
              ? config.persistence.maxRestoredEvents
              : undefined,
        },
      });
    }
    const restoredQueue = restored.queued.map(item => ({
      event: item.event,
      enqueuedAt: item.enqueuedAt,
      seq: item.seq,
    }));
    const queueLimit = Math.max(0, config.maxQueueSize);
    if (restoredQueue.length > queueLimit) {
      const dropped = restoredQueue.length - queueLimit;
      this.queue =
        (config.overflowPolicy ?? 'drop-newest') === 'drop-oldest'
          ? restoredQueue.slice(dropped)
          : restoredQueue.slice(0, queueLimit);
      this.counters.droppedOverflow += dropped;
      this.counters.droppedTotal += dropped;
      this.diagnostics.emit({
        code: 'queue_overflow',
        message: `Restored queue exceeded maxQueueSize; dropped ${dropped} event(s)`,
        affectedEvents: dropped,
        details: { policy: config.overflowPolicy ?? 'drop-newest', restored: restoredQueue.length },
      });
    } else {
      this.queue = restoredQueue;
    }
    this.pendingBatches = restored.pending.map(batch => ({ ...batch, state: 'pending' }));
    this.counters.restoredFromStorage =
      this.queue.length + this.pendingBatches.reduce((total, batch) => total + batch.events.length, 0);
    if (restored.contention) {
      this.diagnostics.emit({
        code: 'storage_contention',
        message: 'Another live Alitycs instance owns this persisted queue; using memory-only mode',
      });
    } else if (this.counters.restoredFromStorage > 0) {
      this.diagnostics.emit({
        code: 'restored_from_storage',
        message: `Restored ${this.counters.restoredFromStorage} event(s) from storage`,
        affectedEvents: this.counters.restoredFromStorage,
      });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending > 0 && !this.isPaused()) void this.flush();
    }, this.config.flushInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  add(event: AnalyticsEvent): void {
    const queueDepth = this.queueDepth;
    if (queueDepth >= this.config.maxQueueSize) {
      const policy = this.config.overflowPolicy ?? 'drop-newest';
      if (policy === 'drop-oldest' && queueDepth > 0) {
        const dropped = this.queue[this.queueHead++];
        this.recordDrop('overflow', dropped.event, 'Queue full — dropped oldest event');
        this.compactQueueIfNeeded();
        this.syncPersistence();
        this.notifyStateChange();
      } else {
        this.recordDrop('overflow', event, 'Queue full — dropped newest event');
        this.notifyStateChange();
        return;
      }
    }

    const enqueuedAt = Date.now();
    const item: QueuedEvent = { event, enqueuedAt, seq: this.nextSeq++ };
    // The event line is written before a later takeEvents() can hand it to a transport.
    this.persistence.appendEvent(event, enqueuedAt, item.seq);
    this.queue.push(item);
    this.notifyStateChange();

    if (this.queueDepth >= this.config.flushSize && !this.isPaused()) void this.flush();
  }

  flush(options: BatchFlushOptions = {}): Promise<FlushResult> {
    if (this.isPaused() && options.force !== true) {
      const result = this.pausedResult();
      this.diagnostics.emit({
        code: 'flush_paused',
        message: 'Delivery is paused until the server-directed deadline',
        retryAfterMs: Math.max(0, (this.pausedUntil ?? Date.now()) - Date.now()),
        details: { pending: result.pending, pausedUntil: result.pausedUntil },
      });
      return Promise.resolve(result);
    }

    if (this.flushPromise) {
      if (options.keepalive === true) {
        const keepalive = this.sendKeepalive(options);
        const tracked = keepalive.finally(() => this.keepalivePromises.delete(tracked));
        this.keepalivePromises.add(tracked);
        return tracked;
      }
      return this.flushPromise.then(() => this.flush(options));
    }

    if (this.outstanding === 0) {
      this.notifyStateChange();
      return Promise.resolve({ status: 'drained', delivered: 0, pending: 0 });
    }

    const promise = this.flushOne(options);
    this.flushPromise = promise;
    void promise.finally(() => {
      if (this.flushPromise === promise) this.flushPromise = null;
      this.notifyStateChange();
    });
    return promise;
  }

  /**
   * Repeatedly attempts outstanding batches until they are acknowledged, paused, or the bounded
   * drain policy quarantines a permanently stalled remainder.
   */
  async drain(options: BatchFlushOptions = {}): Promise<FlushResult> {
    let delivered = 0;
    let stalledRounds = 0;

    while (this.outstanding > 0 || this.flushPromise || this.keepalivePromises.size > 0) {
      const before = this.outstanding;
      let iterationDelivered = 0;
      if (before > 0 || this.flushPromise) {
        const result = await this.flush(options);
        delivered += result.delivered;
        iterationDelivered += result.delivered;
        if (result.status === 'paused' && options.force !== true) break;
      }
      if (this.keepalivePromises.size > 0) {
        await Promise.all([...this.keepalivePromises]);
      }
      if (before > 0 && this.outstanding > 0 && iterationDelivered === 0 && this.outstanding >= before) {
        stalledRounds++;
        if (stalledRounds >= MAX_STALLED_DRAIN_ROUNDS) {
          this.giveUpDrain();
          break;
        }
      } else {
        stalledRounds = 0;
      }
    }

    const result = this.resultFor(delivered);
    // `drain()` is the shutdown path: only an acknowledged empty queue may remove the WAL.
    if (result.status === 'drained') this.persistence.delete();
    this.notifyStateChange();
    return result;
  }

  get pending(): number {
    // Preserve the historical meaning of this getter: queued/requeued events waiting for a
    // send. stats().inFlight and FlushResult.pending also expose an unresolved request.
    return this.queueDepth + this.pendingBatches.reduce((total, batch) => total + batch.events.length, 0);
  }

  get queueDepth(): number {
    return this.queue.length - this.queueHead;
  }

  get hasOutstanding(): boolean {
    return this.outstanding > 0;
  }

  /** Synchronously snapshots queued, pending, and in-flight state before a page exits. */
  saveNow(): void {
    this.syncPersistence();
  }

  /** Releases the storage writer after shutdown has returned a non-drained outcome. */
  releasePersistence(): void {
    this.persistence.release();
  }

  /** Re-arms delivery after a bfcache restore and invalidates a request left suspended by it. */
  rearm(): void {
    const inFlight = this.inFlightBatch;
    if (inFlight) {
      const replay: PendingBatch = {
        ...inFlight,
        events: [...inFlight.events],
        enqueuedAt: inFlight.enqueuedAt ? [...inFlight.enqueuedAt] : undefined,
        state: 'pending',
      };
      this.inFlightBatch = null;
      this.pendingBatches.unshift(replay);
      this.syncPersistence();
    }
    this.flushPromise = null;
    this.stop();
    this.start();
    this.notifyStateChange();
  }

  stats(): DeliveryStats {
    const oldestQueuedAt = this.oldestQueuedAt;
    return {
      queueDepth: this.queueDepth,
      inFlight: this.inFlightBatch?.events.length ?? 0,
      quarantined: this.quarantined.length,
      ...(this.pausedUntil !== undefined ? { pausedUntil: this.pausedUntil } : {}),
      ...(oldestQueuedAt !== undefined
        ? { oldestQueuedAt, oldestQueuedAgeMs: Math.max(0, Date.now() - oldestQueuedAt) }
        : {}),
      lastError: this.lastError,
      ...this.counters,
    };
  }

  quarantinedEvents(): QuarantinedEvent[] {
    return this.quarantined.map(item => ({
      ...item,
      event: { ...item.event, properties: { ...item.event.properties } },
    }));
  }

  recordDeduplicated(): void {
    this.counters.deduplicated++;
    this.diagnostics.emit({ code: 'deduplicated', message: 'Duplicate event suppressed by dedupeKey' });
  }

  recordInvalid(event: AnalyticsEvent | undefined, message: string): void {
    this.counters.droppedInvalid++;
    this.counters.droppedTotal++;
    this.diagnostics.emit({
      code: 'invalid_event',
      message: `Event dropped: ${message}`,
      affectedEvents: 1,
      details: event ? { eventId: event.eventId } : undefined,
    });
  }

  private async flushOne(options: BatchFlushOptions): Promise<FlushResult> {
    const work = await this.sendNext(options);
    return this.resultFor(work.delivered);
  }

  private async sendNext(options: BatchFlushOptions): Promise<FlushWorkResult> {
    const batch = this.takeBatch(options);
    if (!batch) return { delivered: 0, attempted: false };

    const delivered = await this.deliverBatch(batch, options, splitDepth(batch.events.length));
    return { delivered, attempted: true };
  }

  private get outstanding(): number {
    return this.pending + (this.inFlightBatch?.events.length ?? 0);
  }

  private takeBatch(options: BatchFlushOptions): PendingBatch | null {
    const restored = this.pendingBatches[0];
    if (restored) {
      if (options.maxPayloadBytes && this.exceedsLimit(restored, options.maxPayloadBytes)) return null;
      this.pendingBatches.shift();
      restored.state = 'in_flight';
      this.inFlightBatch = restored;
      return restored;
    }

    const active = this.activeQueue();
    if (active.length === 0) return null;
    const batchId = `batch_${generateId()}`;
    const sentAt = Date.now();
    const selected = selectEvents(active, batchId, sentAt, options.maxPayloadBytes);
    if (selected.length === 0) return null;

    const batch: PendingBatch = {
      batchId,
      sentAt,
      events: selected.map(item => item.event),
      enqueuedAt: selected.map(item => item.enqueuedAt),
      state: 'in_flight',
    };
    // WAL handoff happens before the memory queue is advanced.
    this.persistence.appendBatch(batch);
    this.queueHead += selected.length;
    this.compactQueueIfNeeded();
    this.inFlightBatch = batch;
    return batch;
  }

  private async deliverBatch(batch: PendingBatch, options: BatchFlushOptions, depth: number): Promise<number> {
    if (batch.state === 'acked' || batch.state === 'discarded') return 0;
    batch.state = 'in_flight';
    this.inFlightBatch = batch;

    let result: TransportResult;
    try {
      result =
        (await this.transport.send(
          { batchId: batch.batchId, sentAt: batch.sentAt, events: batch.events },
          { keepalive: options.keepalive, maxRetries: options.maxRetries }
        )) ?? DELIVERED;
    } catch (error) {
      result = {
        ok: false,
        transient: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (this.inFlightBatch !== batch) return 0;

    if (result.ok) {
      batch.state = 'acked';
      this.inFlightBatch = null;
      this.persistence.ackBatch(batch.batchId);
      this.counters.delivered += batch.events.length;
      return batch.events.length;
    }

    this.counters.failedDeliveries++;
    this.setLastError(result, batch.events.length);

    if (result.code === 'monthly_event_quota_exceeded') {
      batch.state = 'discarded';
      this.inFlightBatch = null;
      this.persistence.ackBatch(batch.batchId);
      this.counters.acceptedQuotaExceeded += batch.events.length;
      this.counters.droppedTotal += batch.events.length;
      this.diagnostics.emit({
        code: 'accepted_quota_exceeded',
        message: 'Batch was already ingested before the monthly quota response; events were not replayed',
        status: result.status,
        batchId: batch.batchId,
        affectedEvents: batch.events.length,
        retryAfterMs: result.retryAfterMs,
      });
      return 0;
    }

    if (result.transient) {
      if (result.status === 429) {
        this.counters.rateLimited++;
        this.setPause(result.retryAfterMs);
      }
      this.counters.requeued += batch.events.length;
      this.counters.retries++;
      batch.state = 'pending';
      this.inFlightBatch = null;
      this.pendingBatches.unshift(batch);
      this.diagnostics.emit({
        code: result.status === 429 ? 'rate_limited' : 'delivery_requeued',
        message: result.message ?? `Batch send failed — ${batch.events.length} event(s) requeued`,
        status: result.status,
        batchId: batch.batchId,
        affectedEvents: batch.events.length,
        retryAfterMs: result.retryAfterMs,
      });
      return 0;
    }

    if (result.status === 429) {
      this.counters.rateLimited++;
      this.setPause(result.retryAfterMs);
    }

    const split = (result.status === 400 || result.status === 413) && batch.events.length > 1 && depth > 0;
    if (split) {
      this.counters.poisonIsolated++;
      this.inFlightBatch = null;
      this.persistence.removeBatch(batch.batchId);
      batch.state = 'discarded';
      const mid = batch.events.length >> 1;
      const left = this.newChildBatch(batch, 0, mid);
      const right = this.newChildBatch(batch, mid, batch.events.length);
      const leftDelivered = await this.deliverChild(left, options, depth - 1);
      const rightDelivered = await this.deliverChild(right, options, depth - 1);
      return leftDelivered + rightDelivered;
    }

    this.inFlightBatch = null;
    batch.state = 'discarded';
    this.persistence.removeBatch(batch.batchId);
    const reason: QuarantineReason =
      result.status === 413 ? 'payload_too_large' : result.status === 400 ? 'rejected_400' : 'invalid_event';
    for (const event of batch.events) {
      this.counters.droppedRejected++;
      this.counters.droppedTotal++;
      this.quarantine(event, reason, result.status, batch.batchId, result.message);
    }
    this.diagnostics.emit({
      code: 'event_rejected',
      message: result.message ?? `Server rejected batch — ${batch.events.length} event(s) dropped`,
      status: result.status,
      batchId: batch.batchId,
      affectedEvents: batch.events.length,
    });
    return 0;
  }

  private async deliverChild(batch: PendingBatch, options: BatchFlushOptions, depth: number): Promise<number> {
    this.persistence.appendBatch(batch);
    this.inFlightBatch = batch;
    return this.deliverBatch(batch, options, depth);
  }

  private newChildBatch(parent: PendingBatch, start: number, end: number): PendingBatch {
    return {
      batchId: `batch_${generateId()}`,
      sentAt: parent.sentAt,
      events: parent.events.slice(start, end),
      enqueuedAt: parent.enqueuedAt?.slice(start, end),
      state: 'pending',
    };
  }

  private async sendKeepalive(options: BatchFlushOptions): Promise<FlushResult> {
    const batch = this.inFlightBatch;
    if (!batch || batch.state !== 'in_flight') return this.flush(options);
    if (options.maxPayloadBytes && this.exceedsLimit(batch, options.maxPayloadBytes)) return this.resultFor(0);

    let result: TransportResult;
    try {
      result =
        (await this.transport.send(
          { batchId: batch.batchId, sentAt: batch.sentAt, events: batch.events },
          { keepalive: true, maxRetries: options.maxRetries }
        )) ?? DELIVERED;
    } catch (error) {
      result = { ok: false, transient: true, message: error instanceof Error ? error.message : String(error) };
    }
    if (this.inFlightBatch !== batch) return this.resultFor(0);
    if (result.ok) {
      batch.state = 'acked';
      this.inFlightBatch = null;
      this.persistence.ackBatch(batch.batchId);
      this.counters.delivered += batch.events.length;
      this.notifyStateChange();
      return this.resultFor(batch.events.length);
    }
    if (result.code === 'monthly_event_quota_exceeded') {
      batch.state = 'discarded';
      this.inFlightBatch = null;
      this.persistence.ackBatch(batch.batchId);
      this.counters.acceptedQuotaExceeded += batch.events.length;
      this.counters.droppedTotal += batch.events.length;
      this.diagnostics.emit({
        code: 'accepted_quota_exceeded',
        message: 'Batch was already ingested before the monthly quota response; events were not replayed',
        status: result.status,
        batchId: batch.batchId,
        affectedEvents: batch.events.length,
        retryAfterMs: result.retryAfterMs,
      });
      this.notifyStateChange();
      return this.resultFor(0);
    }
    if (result.status === 429) {
      this.counters.rateLimited++;
      this.setPause(result.retryAfterMs);
    }
    this.counters.failedDeliveries++;
    this.setLastError(result, batch.events.length);
    this.notifyStateChange();
    return this.resultFor(0);
  }

  private resultFor(delivered: number): FlushResult {
    if (this.isPaused() && this.outstanding > 0) {
      return { status: 'paused', delivered, pending: this.outstanding, pausedUntil: this.pausedUntil };
    }
    return {
      status: this.outstanding === 0 ? 'drained' : 'partial',
      delivered,
      pending: this.outstanding,
      ...(this.pausedUntil !== undefined && this.outstanding > 0 ? { pausedUntil: this.pausedUntil } : {}),
    };
  }

  private pausedResult(): FlushResult {
    return { status: 'paused', delivered: 0, pending: this.outstanding, pausedUntil: this.pausedUntil };
  }

  private isPaused(): boolean {
    if (this.pausedUntil === undefined) return false;
    if (Date.now() >= this.pausedUntil) {
      this.pausedUntil = undefined;
      this.persistence.setPausedUntil(undefined);
      return false;
    }
    return true;
  }

  private setPause(delayMs: number | undefined): void {
    if (delayMs === undefined || !Number.isFinite(delayMs)) return;
    const deadline = Date.now() + Math.max(0, delayMs);
    this.pausedUntil = Math.max(this.pausedUntil ?? 0, deadline);
    this.persistence.setPausedUntil(this.pausedUntil);
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }

  private setLastError(result: TransportResult, affectedEvents: number): void {
    const kind =
      result.code === 'monthly_event_quota_exceeded'
        ? 'quota'
        : result.status === 401 || result.status === 403
          ? 'auth'
          : result.status === 429
            ? 'rate_limit'
            : result.status !== undefined && result.status >= 500
              ? 'server'
              : result.status !== undefined
                ? 'rejected'
                : 'network';
    this.lastError = {
      at: Date.now(),
      kind,
      ...(result.status !== undefined ? { status: result.status } : {}),
      message: result.message ?? (result.status ? `HTTP ${result.status}` : 'Delivery failed'),
      affectedEvents,
    };
  }

  private recordDrop(kind: 'overflow', event: AnalyticsEvent, message: string): void {
    this.counters.droppedOverflow++;
    this.counters.droppedTotal++;
    this.diagnostics.emit({
      code: 'queue_overflow',
      message,
      affectedEvents: 1,
      details: { eventId: event.eventId, policy: this.config.overflowPolicy ?? 'drop-newest' },
    });
  }

  private quarantine(
    event: AnalyticsEvent,
    reason: QuarantineReason,
    status?: number,
    batchId?: string,
    message?: string
  ): void {
    if (this.quarantined.length >= MAX_QUARANTINED_EVENTS) this.quarantined.shift();
    this.quarantined.push({ event, reason, at: Date.now(), status, batchId, message });
    this.diagnostics.emit({
      code: 'event_quarantined',
      message: message ?? `Event quarantined: ${reason}`,
      status,
      batchId,
      affectedEvents: 1,
      details: { reason, eventId: event.eventId },
    });
  }

  private giveUpDrain(): void {
    const remaining = this.collectOutstandingEvents();
    for (const event of remaining) {
      this.counters.droppedDrainGiveUp++;
      this.counters.droppedTotal++;
      this.quarantine(event, 'drain_gave_up', undefined, undefined, 'Drain gave up after repeated delivery failures');
    }
    // A bounded drain gives up on this invocation, but it must not turn an unknown delivery
    // outcome into an acknowledged empty queue. Keep the exact pending batches in memory/WAL so
    // a later explicit flush or a restarted persistent client can retry them byte-identically.
    if (this.inFlightBatch && !this.pendingBatches.includes(this.inFlightBatch)) {
      this.inFlightBatch.state = 'pending';
      this.pendingBatches.unshift(this.inFlightBatch);
    }
    this.inFlightBatch = null;
    this.persistence.compact(
      this.activeQueue().map(item => ({
        seq: item.seq,
        enqueuedAt: item.enqueuedAt,
        event: item.event,
      })),
      this.pendingBatches
    );
    this.diagnostics.emit({
      code: 'drain_gave_up',
      message: `Drain gave up after repeated delivery failures; ${remaining.length} event(s) quarantined`,
      affectedEvents: remaining.length,
    });
  }

  private collectOutstandingEvents(): AnalyticsEvent[] {
    const events = this.activeQueue().map(item => item.event);
    for (const batch of this.pendingBatches) events.push(...batch.events);
    if (this.inFlightBatch && !this.pendingBatches.includes(this.inFlightBatch))
      events.push(...this.inFlightBatch.events);
    return events;
  }

  private activeQueue(): QueuedEvent[] {
    return this.queue.slice(this.queueHead);
  }

  private compactQueueIfNeeded(): void {
    if (this.queueHead === 0) return;
    if (this.queueHead >= 64 || this.queueHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
  }

  private syncPersistence(): void {
    const queued: PersistedQueuedEvent[] = this.activeQueue().map(item => ({
      seq: item.seq,
      enqueuedAt: item.enqueuedAt,
      event: item.event,
    }));
    const pending = [
      ...this.pendingBatches,
      ...(this.inFlightBatch && this.inFlightBatch.state === 'in_flight' ? [this.inFlightBatch] : []),
    ];
    this.persistence.compact(queued, pending);
  }

  private get oldestQueuedAt(): number | undefined {
    const ages: number[] = this.activeQueue().map(item => item.enqueuedAt);
    for (const batch of this.pendingBatches) ages.push(...(batch.enqueuedAt ?? batch.events.map(() => batch.sentAt)));
    if (this.inFlightBatch)
      ages.push(...(this.inFlightBatch.enqueuedAt ?? this.inFlightBatch.events.map(() => this.inFlightBatch!.sentAt)));
    return ages.length > 0 ? Math.min(...ages) : undefined;
  }

  private exceedsLimit(batch: PersistedBatch, maxPayloadBytes: number): boolean {
    return (
      new TextEncoder().encode(JSON.stringify({ batchId: batch.batchId, sentAt: batch.sentAt, events: batch.events }))
        .byteLength > maxPayloadBytes
    );
  }
}

function splitDepth(eventCount: number): number {
  return eventCount > 1 ? Math.ceil(Math.log2(eventCount)) + 1 : 0;
}

function selectEvents(
  queue: QueuedEvent[],
  batchId: string,
  sentAt: number,
  maxPayloadBytes: number | undefined
): QueuedEvent[] {
  if (!maxPayloadBytes) return queue;
  const selected: QueuedEvent[] = [];
  for (const candidate of queue) {
    const events = [...selected, candidate.event];
    const bytes = new TextEncoder().encode(JSON.stringify({ batchId, sentAt, events })).byteLength;
    if (bytes <= maxPayloadBytes) {
      selected.push(candidate);
      continue;
    }
    // Keep an individually oversized event queued for the normal delivery path; a keepalive
    // payload limit is a client transport constraint, not proof that the event is poison.
    break;
  }
  return selected;
}
