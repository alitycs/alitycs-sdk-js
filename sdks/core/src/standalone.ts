import type {
  AlitycsConfig,
  AnalyticsEvent,
  BatchPayload,
  EventContext,
  EventOptions,
  EventType,
  ResolvedConfig,
} from './types';
import { UTM_KEYS, utmParam } from './utils';
import { HttpTransport } from './transport';
import { SessionManager } from './session';
import { createLogger, type Logger } from './logger';
import { EventDeduplicator } from './dedup';
import { RESERVED_EVENT_NAMES, buildAnalyticsEvent, validateEvent } from './event';
import {
  StandaloneBatchManager,
  type StandaloneFlushOptions,
  type StandaloneFlushResult,
} from './standalone-batch-manager';

const DEFAULTS: Omit<ResolvedConfig, 'apiKey'> = {
  endpoint: 'https://api.alitycs.com/events',
  flushInterval: 10_000,
  flushSize: 25,
  maxQueueSize: 1000,
  maxRetries: 3,
  requestTimeout: 10_000,
  debug: false,
  sessionTimeout: 30 * 60 * 1000,
  batching: true,
  onDiagnostics: undefined,
  persistence: false,
  overflowPolicy: 'drop-newest',
};

export interface StandaloneAlitycsConfig extends AlitycsConfig {
  /** Accepted for source compatibility with the browser entry; the GA4 bridge does not auto-capture. */
  autoCapture?: boolean;
}

/**
 * Compact memory-only client for the size-constrained GA4 IIFE. The regular browser entry uses
 * the full Alitycs client with persistence and diagnostics; this entry still shares event
 * construction, transport, sessions, and the stable batch/retry wire contract.
 */
export class StandaloneAlitycs {
  private readonly transport: HttpTransport;
  private readonly manager: StandaloneBatchManager;
  private readonly sessionManager: SessionManager;
  private readonly logger: Logger;
  private userId: string | undefined;
  private globalProperties: Record<string, unknown> = {};
  private readonly deduplicator = new EventDeduplicator();
  private lastEventTimestamp = 0;
  private shutDown = false;

  protected constructor(config: ResolvedConfig) {
    this.logger = createLogger(config.debug);
    this.transport = new HttpTransport({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxRetries: config.maxRetries,
      requestTimeout: config.requestTimeout,
      logger: this.logger,
    });
    this.sessionManager = new SessionManager(config.sessionTimeout, () => {
      this.userId = undefined;
    });
    this.userId = this.sessionManager.getSession().userId;
    this.manager = new StandaloneBatchManager(config, this.transport, this.logger);
    this.manager.start();
  }

  static init(config: StandaloneAlitycsConfig): StandaloneAlitycs {
    if (!config.apiKey || config.apiKey.trim() === '') throw new Error('apiKey is required');
    const resolved = { ...DEFAULTS, ...config, apiKey: config.apiKey } as ResolvedConfig;
    return new StandaloneAlitycs(resolved);
  }

  track(eventName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
    if (eventName) this.enqueue('track', eventName, properties, options);
  }

  captureError(errorName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
    if (errorName) this.enqueue('error', errorName, properties, options);
  }

  identify(userId: string, traits?: Record<string, unknown>, options?: EventOptions): void {
    if (!userId) return;
    this.userId = userId;
    this.sessionManager.setUserId(userId);
    this.enqueue('identify', 'identify', { userId, ...traits }, options);
  }

  alias(previousId: string, options?: EventOptions): void {
    if (previousId?.trim()) this.enqueue('identify', RESERVED_EVENT_NAMES.alias, { previousId }, options);
  }

  set(traits: Record<string, unknown>, options?: EventOptions): void {
    if (traits && Object.keys(traits).length) this.enqueue('identify', RESERVED_EVENT_NAMES.set, traits, options);
  }

  setOnce(traits: Record<string, unknown>, options?: EventOptions): void {
    if (traits && Object.keys(traits).length) this.enqueue('identify', RESERVED_EVENT_NAMES.setOnce, traits, options);
  }

  unset(keys: string[], options?: EventOptions): void {
    const values = Array.isArray(keys) ? keys.filter(key => typeof key === 'string' && key.trim()) : [];
    if (values.length) this.enqueue('identify', RESERVED_EVENT_NAMES.unset, { $keys: JSON.stringify(values) }, options);
  }

  reset(): void {
    this.userId = undefined;
    this.sessionManager.reset();
  }

  page(name?: string, properties?: Record<string, unknown>, options?: EventOptions): void {
    const pageName = name || 'page_view';
    this.enqueue(
      'page',
      pageName,
      {
        ...properties,
        title: properties?.title ?? (typeof document !== 'undefined' ? document.title : undefined),
      },
      options,
      pageContextOverrides(properties)
    );
  }

  setGlobalProperties(properties: Record<string, unknown>): void {
    Object.assign(this.globalProperties, properties);
  }

  getGlobalProperties(): Record<string, unknown> {
    return { ...this.globalProperties };
  }

  removeGlobalProperties(keys: string[]): void {
    for (const key of keys) delete this.globalProperties[key];
  }

  clearGlobalProperties(): void {
    this.globalProperties = {};
  }

  flush(options: StandaloneFlushOptions = {}): Promise<StandaloneFlushResult> {
    return this.manager.flush(options);
  }

  async shutdown(): Promise<StandaloneFlushResult> {
    this.manager.stop();
    const result = await this.manager.drain();
    this.deduplicator.clear();
    this.shutDown = true;
    return result;
  }

  get pending(): number {
    return this.manager.pending;
  }

  get isShutdown(): boolean {
    return this.shutDown;
  }

  private enqueue(
    type: EventType,
    name: string,
    properties?: Record<string, unknown>,
    options?: EventOptions,
    contextOverrides?: Partial<EventContext>
  ): void {
    if (this.shutDown) return;
    if (options?.dedupeKey && this.deduplicator.isDuplicate(options.dedupeKey, options.dedupeWindowMs ?? 500)) return;
    this.sessionManager.touch();
    const session = this.sessionManager.getSession();
    const timestamp = Math.max(Date.now(), this.lastEventTimestamp + 1);
    this.lastEventTimestamp = timestamp;
    const event: AnalyticsEvent = buildAnalyticsEvent({
      eventType: type,
      eventName: name,
      userId: this.userId,
      anonymousId: session.anonymousId,
      sessionId: session.id,
      timestamp,
      properties: { ...this.globalProperties, ...(properties ?? {}) },
      contextOverrides,
      dedupeKey: options?.dedupeKey,
    });
    const rejection = validateEvent(event);
    if (rejection) {
      this.logger.warn(`Event dropped: ${rejection}`);
      return;
    }
    this.manager.add(event);
  }
}

function pageContextOverrides(properties?: Record<string, unknown>): Partial<EventContext> {
  const url = typeof properties?.url === 'string' ? properties.url : undefined;
  const overrides: Partial<EventContext> = {};
  if (url) {
    overrides.url = url;
    try {
      const params = new URL(url).searchParams;
      for (const key of UTM_KEYS) overrides[key] = params.get(utmParam(key)) ?? undefined;
    } catch {
      // Keep a caller-supplied non-standard URL without failing the event.
    }
  }
  if (typeof properties?.referrer === 'string') overrides.referrer = properties.referrer;
  return overrides;
}

export type StandaloneBatchPayload = BatchPayload;
