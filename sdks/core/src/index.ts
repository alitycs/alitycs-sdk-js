import type {
  AlitycsConfig,
  ResolvedConfig,
  BatchPayload,
  EventType,
  EventOptions,
  EventContext,
  RevenuePayload,
} from './types';
import { generateId, UTM_KEYS, utmParam } from './utils';
import { HttpTransport } from './transport';
import { BatchManager } from './batch-manager';
import { SessionManager } from './session';
import { createLogger, type Logger } from './logger';
import { EventDeduplicator } from './dedup';
import { buildAnalyticsEvent, validateEvent } from './event';

export const DEFAULTS: Omit<ResolvedConfig, 'apiKey'> = {
  endpoint: 'https://api.alitycs.com/events',
  flushInterval: 10_000,
  flushSize: 25,
  maxQueueSize: 1000,
  maxRetries: 3,
  debug: false,
  sessionTimeout: 30 * 60 * 1000,
  batching: true,
};

// Client-side event limits and wire-event construction live in ./event.ts, shared with
// the stateless server client so both surfaces emit byte-identical payloads.

export class Alitycs {
  protected config: ResolvedConfig;
  protected transport: HttpTransport;
  protected batchManager: BatchManager | null = null;
  protected sessionManager: SessionManager;
  protected logger: Logger;
  private userId: string | undefined;
  private inFlight = new Set<Promise<void>>();
  private globalProperties: Record<string, unknown> = {};
  private deduplicator = new EventDeduplicator();
  private lastEventTimestamp = 0;
  private droppedCount = 0;
  private shutDown = false;

  protected constructor(config: ResolvedConfig) {
    if (!(config.flushSize >= 1) || !(config.maxQueueSize >= 1) || !(config.flushInterval >= 1)) {
      throw new Error('flushSize, maxQueueSize, and flushInterval must be positive numbers');
    }
    this.config = config;
    this.logger = createLogger(config.debug);
    this.transport = new HttpTransport({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxRetries: config.maxRetries,
      requestTimeout: config.requestTimeout,
      logger: this.logger,
    });
    this.sessionManager = new SessionManager(config.sessionTimeout);
    this.userId = this.sessionManager.getSession().userId;

    if (config.batching) {
      this.batchManager = new BatchManager(config, this.transport, this.logger);
      this.batchManager.start();
    }
  }

  static init(config: AlitycsConfig): Alitycs {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('apiKey is required');
    }
    const resolved: ResolvedConfig = { ...DEFAULTS, ...config } as ResolvedConfig;
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

  async flush(): Promise<void> {
    if (this.batchManager) {
      await this.batchManager.flush();
    } else {
      await Promise.all(this.inFlight);
    }
  }

  protected flushForPageExit(): void {
    if (this.batchManager) {
      void this.batchManager.flush({
        keepalive: true,
        maxPayloadBytes: 60_000,
        maxRetries: 0,
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.batchManager) {
      this.batchManager.stop();
      // Drain rather than flush once: a payload-bounded send can leave a remainder.
      await this.batchManager.drain();
    } else {
      await Promise.all(this.inFlight);
    }
    this.deduplicator.clear();
    this.shutDown = true;
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
      this.logger.warn(`Event dropped: ${rejection}`);
      return;
    }

    if (this.batchManager) {
      this.batchManager.add(event);
    } else {
      const payload: BatchPayload = {
        batchId: `batch_${generateId()}`,
        sentAt: Date.now(),
        events: [event],
      };
      const promise = this.transport.send(payload).then(
        () => {
          this.inFlight.delete(promise);
        },
        () => {
          this.inFlight.delete(promise);
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

export function reset(): void {
  defaultInstance?.reset();
}

export function page(name?: string, properties?: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.page(name, properties, options);
}

export async function flush(): Promise<void> {
  await defaultInstance?.flush();
}

export async function shutdown(): Promise<void> {
  await defaultInstance?.shutdown();
  defaultInstance = undefined;
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
  EventContext,
  BatchPayload,
  SessionData,
  EventOptions,
  RevenuePayload,
} from './types';
export { createLogger } from './logger';
export { UTM_KEYS } from './utils';
export type { Logger } from './logger';
// Exported building blocks for the stateless @alitycs/server client, which composes the
// same transport/batch/validation primitives without inheriting ambient identity state.
export { HttpTransport } from './transport';
export { BatchManager } from './batch-manager';
export { EventDeduplicator } from './dedup';
export {
  RESERVED_EVENT_NAMES,
  buildAnalyticsEvent,
  validateEvent,
  type BuildAnalyticsEventInput,
} from './event';

function validateRevenuePayload(payload: RevenuePayload): void {
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
