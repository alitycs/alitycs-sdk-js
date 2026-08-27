import type {
  AlitycsConfig,
  ResolvedConfig,
  BatchPayload,
  EventType,
  EventOptions,
  EventContext,
  RevenuePayload,
  DeliveryStats,
} from './types';
import { generateId, UTM_KEYS, utmParam } from './utils';
import { HttpTransport } from './transport';
import { SessionManager } from './session';
import { createLogger, type Logger } from './logger';
import { EventDeduplicator } from './dedup';
import { resolveAlitycsConfig } from './config';
import { DiagnosticsHub, type DiagnosticsSink } from './diagnostics';
import { BatchManager, type BatchFlushOptions, type FlushResult, type QuarantinedEvent } from './batch-manager';
import { RESERVED_EVENT_NAMES, buildAnalyticsEvent, validateEvent } from './event';

// Client-side event limits and wire-event construction live in ./event.ts, shared with
// the stateless server client so both surfaces emit byte-identical payloads.

export class Alitycs {
  protected config: ResolvedConfig;
  protected transport: HttpTransport;
  protected batchManager: BatchManager | null = null;
  protected sessionManager: SessionManager;
  protected logger: Logger;
  protected diagnostics: DiagnosticsHub;
  private userId: string | undefined;
  private inFlight = new Set<Promise<void>>();
  private globalProperties: Record<string, unknown> = {};
  private deduplicator = new EventDeduplicator();
  private lastEventTimestamp = 0;
  private droppedCount = 0;
  private nonBatchDelivered = 0;
  private nonBatchFailed = 0;
  private nonBatchDeduplicated = 0;
  private nonBatchLastError: DeliveryStats['lastError'] = null;
  private acceptedEventGeneration = 0;
  private shutDown = false;

  protected constructor(config: ResolvedConfig) {
    if (!(config.flushSize >= 1) || !(config.maxQueueSize >= 1) || !(config.flushInterval >= 1)) {
      throw new Error('flushSize, maxQueueSize, and flushInterval must be positive numbers');
    }
    this.config = config;
    this.logger = createLogger(config.debug);
    this.diagnostics = new DiagnosticsHub(config.onDiagnostics, this.logger);
    this.transport = new HttpTransport({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxRetries: config.maxRetries,
      requestTimeout: config.requestTimeout,
      logger: this.logger,
    });
    // Session rotation (expiry-driven recreation) invalidates the identified user, matching the
    // JVM/Go SDKs: post-rotation events must not keep stamping the pre-rotation identity.
    this.sessionManager = new SessionManager(config.sessionTimeout, () => {
      this.userId = undefined;
    });
    this.userId = this.sessionManager.getSession().userId;

    if (config.batching) {
      this.batchManager = new BatchManager(config, this.transport, this.logger, this.diagnostics, () =>
        this.onDeliveryStateChanged()
      );
      this.batchManager.start();
    }
  }

  static init(config: AlitycsConfig): Alitycs {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('apiKey is required');
    }
    const resolved = resolveAlitycsConfig(config);
    return new Alitycs(resolved);
  }

  track(eventName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
    if (!eventName) return;
    this.enqueue('track', eventName, properties, options);
  }

  /** Server-only trusted revenue ingestion. Requires a secret key with revenue:write. */
  trackRevenue(payload: RevenuePayload, properties?: Record<string, unknown>): void {
    validateRevenuePayload(payload);
    this.enqueue('track', `revenue_${payload.kind}`, properties, undefined, undefined, undefined, payload);
  }

  captureError(errorName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
    if (!errorName) return;
    this.enqueue('error', errorName, properties, options);
  }

  identify(userId: string, traits?: Record<string, unknown>, options?: EventOptions): void {
    if (!userId) return;
    this.userId = userId;
    this.sessionManager.setUserId(userId);
    this.enqueue('identify', 'identify', { userId, ...traits }, options);
  }

  /**
   * Links a previous identity (anonymous or user) to the current one so analytics can merge
   * the two histories. Emits an identify-type '$alias' event; no-op when previousId is blank.
   */
  alias(previousId: string, options?: EventOptions): void {
    if (!previousId || !previousId.trim()) return;
    this.enqueue('identify', RESERVED_EVENT_NAMES.alias, { previousId }, options);
  }

  /** Latest-wins person traits ('$set'). Values serialize like track() properties. */
  set(traits: Record<string, unknown>, options?: EventOptions): void {
    if (!traits || Object.keys(traits).length === 0) return;
    this.enqueue('identify', RESERVED_EVENT_NAMES.set, traits, options);
  }

  /** First-wins person traits ('$set_once'): downstream keeps the earliest value per key. */
  setOnce(traits: Record<string, unknown>, options?: EventOptions): void {
    if (!traits || Object.keys(traits).length === 0) return;
    this.enqueue('identify', RESERVED_EVENT_NAMES.setOnce, traits, options);
  }

  /**
   * Removes person traits ('$unset'). The key list travels as JSON in the '$keys' property
   * because event property values are always strings on the wire.
   */
  unset(keys: string[], options?: EventOptions): void {
    const removable = Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.trim() !== '') : [];
    if (removable.length === 0) return;
    this.enqueue('identify', RESERVED_EVENT_NAMES.unset, { $keys: JSON.stringify(removable) }, options);
  }

  reset(): void {
    this.userId = undefined;
    this.sessionManager.reset();
  }

  page(name?: string, properties?: Record<string, unknown>, options?: EventOptions): void {
    this.enqueuePage(name, properties, options);
  }

  protected pageAt(
    capturedAt: number,
    name?: string,
    properties?: Record<string, unknown>,
    options?: EventOptions
  ): void {
    this.enqueuePage(name, properties, options, capturedAt);
  }

  private enqueuePage(
    name?: string,
    properties?: Record<string, unknown>,
    options?: EventOptions,
    capturedAt?: number
  ): void {
    const pageName = name || 'page_view';
    const contextOverrides = pageContextOverrides(properties);
    this.enqueue(
      'page',
      pageName,
      {
        ...properties,
        title: properties?.title ?? (typeof document !== 'undefined' ? document.title : undefined),
      },
      options,
      contextOverrides,
      capturedAt
    );
  }

  setGlobalProperties(properties: Record<string, unknown>): void {
    Object.assign(this.globalProperties, properties);
  }

  getGlobalProperties(): Record<string, unknown> {
    return { ...this.globalProperties };
  }

  removeGlobalProperties(keys: string[]): void {
    for (const key of keys) {
      delete this.globalProperties[key];
    }
  }

  clearGlobalProperties(): void {
    this.globalProperties = {};
  }

  async flush(options: BatchFlushOptions = {}): Promise<FlushResult> {
    if (this.batchManager) {
      return this.batchManager.flush(options);
    } else {
      await Promise.all(this.inFlight);
      return {
        status: 'drained',
        delivered: 0,
        pending: 0,
      };
    }
  }

  /** Drains all currently outstanding batches; adapters use this for per-request delivery. */
  async drain(options: BatchFlushOptions = {}): Promise<FlushResult> {
    if (this.batchManager) return this.batchManager.drain(options);
    await Promise.all(this.inFlight);
    return { status: 'drained', delivered: 0, pending: 0 };
  }

  protected flushForPageExit(): Promise<FlushResult> {
    if (this.batchManager) {
      return this.batchManager.flush({
        keepalive: true,
        maxPayloadBytes: 60_000,
        maxRetries: 0,
        force: true,
      });
    }
    return Promise.resolve({ status: 'drained', delivered: 0, pending: 0 });
  }

  protected saveNowForPageExit(): void {
    this.batchManager?.saveNow();
  }

  protected rearmAfterPageShow(): void {
    this.batchManager?.rearm();
  }

  protected get deliveryGeneration(): number {
    return this.acceptedEventGeneration;
  }

  protected get hasPendingDelivery(): boolean {
    return this.batchManager?.hasOutstanding ?? this.inFlight.size > 0;
  }

  /** Hook for browser adapters that need to arm lifecycle listeners after a valid event. */
  protected onEventAccepted(): void {}

  /** Hook for adapters that need to react when queued/in-flight delivery settles. */
  protected onDeliveryStateChanged(): void {}

  protected markEventAccepted(): void {
    this.acceptedEventGeneration++;
    this.onEventAccepted();
  }

  async shutdown(): Promise<FlushResult> {
    if (this.batchManager) {
      this.batchManager.stop();
      // Drain rather than flush once: a payload-bounded send can leave a remainder.
      const result = await this.batchManager.drain();
      if (result.status !== 'drained') this.batchManager.releasePersistence();
      this.deduplicator.clear();
      this.shutDown = true;
      return result;
    } else {
      await Promise.all(this.inFlight);
    }
    this.deduplicator.clear();
    this.shutDown = true;
    return { status: 'drained', delivered: 0, pending: 0 };
  }

  /** True once shutdown() has completed; a shut-down client must not be reused. */
  get isShutdown(): boolean {
    return this.shutDown;
  }

  get pending(): number {
    if (this.batchManager) {
      return this.batchManager.pending;
    }
    return this.inFlight.size;
  }

  /** Events rejected client-side at enqueue (limits, identity, timestamp sanity). */
  get droppedEvents(): number {
    return this.droppedCount;
  }

  stats(): DeliveryStats {
    if (this.batchManager) return this.batchManager.stats();
    return {
      queueDepth: 0,
      inFlight: this.inFlight.size,
      quarantined: 0,
      poisonIsolated: 0,
      lastError: this.nonBatchLastError,
      delivered: this.nonBatchDelivered,
      failedDeliveries: this.nonBatchFailed,
      requeued: 0,
      retries: 0,
      rateLimited: 0,
      acceptedQuotaExceeded: 0,
      droppedOverflow: 0,
      droppedInvalid: this.droppedCount,
      droppedRejected: 0,
      droppedDrainGiveUp: 0,
      droppedTotal: this.droppedCount,
      deduplicated: this.nonBatchDeduplicated,
      restoredFromStorage: 0,
    };
  }

  quarantinedEvents(): QuarantinedEvent[] {
    return this.batchManager?.quarantinedEvents() ?? [];
  }

  /** Adds a diagnostics sink without changing the client's configuration identity. */
  addDiagnosticsListener(sink: DiagnosticsSink): () => void {
    return this.diagnostics.subscribe(sink);
  }

  private enqueue(
    type: EventType,
    name: string,
    properties?: Record<string, unknown>,
    options?: EventOptions,
    contextOverrides?: Partial<EventContext>,
    capturedAt?: number,
    revenue?: RevenuePayload
  ): void {
    if (options?.dedupeKey && this.deduplicator.isDuplicate(options.dedupeKey, options.dedupeWindowMs ?? 500)) {
      if (this.batchManager) this.batchManager.recordDeduplicated();
      else {
        this.nonBatchDeduplicated++;
        this.diagnostics.emit({ code: 'deduplicated', message: 'Duplicate event suppressed by dedupeKey' });
      }
      return;
    }

    this.sessionManager.touch();
    const session = this.sessionManager.getSession();

    const requestedTimestamp = Number.isFinite(capturedAt) ? Math.trunc(capturedAt as number) : Date.now();
    const timestamp = Math.max(requestedTimestamp, this.lastEventTimestamp + 1);
    this.lastEventTimestamp = timestamp;

    const event = buildAnalyticsEvent({
      eventType: type,
      eventName: name,
      userId: this.userId,
      anonymousId: session.anonymousId,
      sessionId: session.id,
      timestamp,
      properties: { ...this.globalProperties, ...(properties ?? {}) },
      contextOverrides,
      revenue,
      dedupeKey: options?.dedupeKey,
    });

    const rejection = validateEvent(event);
    if (rejection) {
      this.droppedCount++;
      if (this.batchManager) this.batchManager.recordInvalid(event, rejection);
      else {
        this.diagnostics.emit({
          code: 'invalid_event',
          message: `Event dropped: ${rejection}`,
          affectedEvents: 1,
          details: { eventId: event.eventId },
        });
      }
      return;
    }

    if (this.batchManager) {
      this.markEventAccepted();
      this.batchManager.add(event);
    } else {
      this.markEventAccepted();
      const payload: BatchPayload = {
        batchId: `batch_${generateId()}`,
        sentAt: Date.now(),
        events: [event],
      };
      const promise = this.transport.send(payload).then(
        result => {
          this.inFlight.delete(promise);
          if (result?.ok) {
            this.nonBatchDelivered++;
            this.onDeliveryStateChanged();
            return;
          }
          this.nonBatchFailed++;
          this.nonBatchLastError = {
            at: Date.now(),
            kind:
              result?.status === 401 || result?.status === 403
                ? 'auth'
                : result?.status === 429
                  ? 'rate_limit'
                  : 'network',
            ...(result?.status !== undefined ? { status: result.status } : {}),
            message: result?.message ?? 'Delivery failed',
            affectedEvents: 1,
          };
          this.diagnostics.emit({
            code: result?.status === 429 ? 'rate_limited' : 'delivery_failed',
            message: result?.message ?? 'Non-batching delivery failed',
            status: result?.status,
            affectedEvents: 1,
            retryAfterMs: result?.retryAfterMs,
          });
          this.onDeliveryStateChanged();
        },
        error => {
          this.inFlight.delete(promise);
          this.nonBatchFailed++;
          this.nonBatchLastError = {
            at: Date.now(),
            kind: 'network',
            message: error instanceof Error ? error.message : String(error),
            affectedEvents: 1,
          };
          this.diagnostics.emit({
            code: 'delivery_failed',
            message: error instanceof Error ? error.message : String(error),
            affectedEvents: 1,
          });
          this.onDeliveryStateChanged();
        }
      );
      this.inFlight.add(promise);
    }
  }
}

function pageContextOverrides(properties?: Record<string, unknown>): Partial<EventContext> {
  const url = typeof properties?.url === 'string' ? properties.url : undefined;
  const hasReferrer = typeof properties?.referrer === 'string';
  const overrides: Partial<EventContext> = {};
  if (url) {
    overrides.url = url;
    try {
      const params = new URL(url).searchParams;
      for (const key of UTM_KEYS) {
        const value = params.get(utmParam(key));
        if (value) overrides[key] = value;
      }
    } catch {
      // Keep the captured URL even when a caller supplies a non-standard value.
    }
  }
  if (hasReferrer) overrides.referrer = properties?.referrer as string;
  return overrides;
}

// --- Module-level convenience (optional default instance) ---

let defaultInstance: Alitycs | undefined;

export function init(config: AlitycsConfig): Alitycs {
  defaultInstance = Alitycs.init(config);
  return defaultInstance;
}

export function track(eventName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.track(eventName, properties, options);
}

export function trackRevenue(payload: RevenuePayload, properties?: Record<string, unknown>): void {
  defaultInstance?.trackRevenue(payload, properties);
}

export function captureError(errorName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.captureError(errorName, properties, options);
}

export function identify(userId: string, traits?: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.identify(userId, traits, options);
}

export function alias(previousId: string, options?: EventOptions): void {
  defaultInstance?.alias(previousId, options);
}

export function set(traits: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.set(traits, options);
}

export function setOnce(traits: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.setOnce(traits, options);
}

export function unset(keys: string[], options?: EventOptions): void {
  defaultInstance?.unset(keys, options);
}

export function reset(): void {
  defaultInstance?.reset();
}

export function page(name?: string, properties?: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.page(name, properties, options);
}

export function flush(options: BatchFlushOptions = {}): Promise<FlushResult> {
  return defaultInstance?.flush(options) ?? emptyFlushResult();
}

export function shutdown(): Promise<FlushResult> {
  const result = defaultInstance?.shutdown() ?? emptyFlushResult();
  defaultInstance = undefined;
  return result;
}

export function stats(): DeliveryStats {
  return (
    defaultInstance?.stats() ?? {
      queueDepth: 0,
      inFlight: 0,
      quarantined: 0,
      poisonIsolated: 0,
      lastError: null,
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
    }
  );
}

export function quarantinedEvents(): QuarantinedEvent[] {
  return defaultInstance?.quarantinedEvents() ?? [];
}

export function setGlobalProperties(properties: Record<string, unknown>): void {
  defaultInstance?.setGlobalProperties(properties);
}

export function getGlobalProperties(): Record<string, unknown> {
  return defaultInstance?.getGlobalProperties() ?? {};
}

export function removeGlobalProperties(keys: string[]): void {
  defaultInstance?.removeGlobalProperties(keys);
}

export function clearGlobalProperties(): void {
  defaultInstance?.clearGlobalProperties();
}

// Re-export types
export type {
  AlitycsConfig,
  ResolvedConfig,
  AnalyticsEvent,
  EventType,
  ReservedEventName,
  EventContext,
  BatchPayload,
  SessionData,
  EventOptions,
  RevenuePayload,
  DeliveryStats,
  DeliveryError,
  PersistenceOptions,
  OverflowPolicy,
} from './types';
export { createLogger } from './logger';
export { UTM_KEYS } from './utils';
export type { Logger } from './logger';
export { DEFAULTS, resolveAlitycsConfig } from './config';
export { DiagnosticsHub } from './diagnostics';
export type { DiagnosticCode, DiagnosticEvent, DiagnosticInput, DiagnosticLevel, DiagnosticsSink } from './diagnostics';
export { MemoryEventStorage, selectEventStorage } from './storage';
export type { EventStorage } from './storage';
export {
  EventPersistence,
  eventStorageKey,
  fingerprintStorageIdentity,
  DEFAULT_PERSISTENCE_OPTIONS,
} from './persistence';
// Exported building blocks for the stateless @alitycs/server client, which composes the
// same transport/batch/validation primitives without inheriting ambient identity state.
export { HttpTransport } from './transport';
export { BatchManager } from './batch-manager';
export type { BatchFlushOptions, FlushResult, FlushStatus, QuarantinedEvent, QuarantineReason } from './batch-manager';
export { EventDeduplicator } from './dedup';
export { RESERVED_EVENT_NAMES, buildAnalyticsEvent, validateEvent, type BuildAnalyticsEventInput } from './event';

function emptyFlushResult(): Promise<FlushResult> {
  return Promise.resolve({ status: 'drained', delivered: 0, pending: 0 });
}

export function validateRevenuePayload(payload: RevenuePayload): void {
  const values = payload as RevenuePayload & Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.factId !== 'string' ||
    payload.factId.length === 0 ||
    payload.factId.trim().length === 0 ||
    payload.factId.length > 200
  ) {
    throw new Error('Revenue payload requires version 1 and a factId between 1 and 200 characters');
  }
  if (!/^[A-Z]{3}$/.test(payload.currency)) {
    throw new Error('Revenue currency must be a three-letter uppercase code');
  }
  const amount =
    payload.kind === 'transaction' ? payload.amount : payload.kind === 'mrr_snapshot' ? payload.mrrAmount : null;
  if (amount !== null && !/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(amount)) {
    throw new Error('Revenue amounts must be non-exponent decimal strings with at most 9 fraction digits');
  }
  if (amount !== null && (amount.replace('-', '').replace('.', '').replace(/^0+/, '').length || 1) > 38) {
    throw new Error('Revenue amounts must not exceed 38 digits of precision');
  }
  if (payload.kind === 'transaction') {
    if (
      values.subscriptionId !== undefined ||
      values.mrrAmount !== undefined ||
      values.expectedActiveSubscriptions !== undefined
    ) {
      throw new Error('Transactions cannot contain recurring revenue fields');
    }
    return;
  }
  if (payload.kind === 'mrr_snapshot') {
    if (
      payload.mrrAmount.startsWith('-') ||
      !payload.subscriptionId ||
      !payload.customerId ||
      values.amount !== undefined ||
      values.expectedActiveSubscriptions !== undefined
    ) {
      throw new Error('MRR snapshots require only a customer, subscription, and non-negative amount');
    }
    return;
  }
  if (
    !Number.isInteger(payload.expectedActiveSubscriptions) ||
    payload.expectedActiveSubscriptions < 0 ||
    values.amount !== undefined ||
    values.mrrAmount !== undefined ||
    values.subscriptionId !== undefined ||
    values.customerId !== undefined
  ) {
    throw new Error('MRR baselines require only a non-negative expectedActiveSubscriptions integer');
  }
}
