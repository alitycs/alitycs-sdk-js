import type { AlitycsConfig, ResolvedConfig, AnalyticsEvent, BatchPayload, EventType } from './types';
import { generateId, serializeProperties } from './utils';
import { HttpTransport } from './transport';
import { BatchManager } from './batch-manager';
import { SessionManager } from './session';
import { collectContext } from './context';
import { createLogger } from './logger';
import type { Logger } from './logger';

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

export class Alitycs {
  protected config: ResolvedConfig;
  protected transport: HttpTransport;
  protected batchManager: BatchManager | null = null;
  protected sessionManager: SessionManager;
  protected logger: Logger;
  private userId: string | undefined;
  private inFlight = new Set<Promise<void>>();
  private globalProperties: Record<string, unknown> = {};

  protected constructor(config: ResolvedConfig) {
    this.config = config;
    this.logger = createLogger(config.debug);
    this.transport = new HttpTransport({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxRetries: config.maxRetries,
      logger: this.logger,
    });
    this.sessionManager = new SessionManager(config.sessionTimeout);

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

  track(eventName: string, properties?: Record<string, unknown>): void {
    if (!eventName) return;
    this.enqueue('track', eventName, properties);
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    if (!userId) return;
    this.userId = userId;
    this.sessionManager.setUserId(userId);
    this.enqueue('identify', 'identify', { userId, ...traits });
  }

  page(name?: string, properties?: Record<string, unknown>): void {
    const pageName = name || 'page_view';
    this.enqueue('page', pageName, {
      ...properties,
      title: typeof document !== 'undefined' ? document.title : undefined,
    });
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

  async shutdown(): Promise<void> {
    if (this.batchManager) {
      this.batchManager.stop();
      await this.batchManager.flush();
    } else {
      await Promise.all(this.inFlight);
    }
  }

  get pending(): number {
    if (this.batchManager) {
      return this.batchManager.pending;
    }
    return this.inFlight.size;
  }

  private enqueue(type: EventType, name: string, properties?: Record<string, unknown>): void {
    this.sessionManager.touch();
    const session = this.sessionManager.getSession();

    const event: AnalyticsEvent = {
      eventId: `evt_${generateId()}`,
      event: name,
      eventType: type,
      userId: this.userId,
      anonymousId: session.anonymousId,
      sessionId: session.id,
      timestamp: Date.now(),
      properties: serializeProperties({ ...this.globalProperties, ...(properties ?? {}) }),
      context: collectContext(),
    };

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

// --- Module-level convenience (optional default instance) ---

let defaultInstance: Alitycs | undefined;

export function init(config: AlitycsConfig): Alitycs {
  defaultInstance = Alitycs.init(config);
  return defaultInstance;
}

export function track(eventName: string, properties?: Record<string, unknown>): void {
  defaultInstance?.track(eventName, properties);
}

export function identify(userId: string, traits?: Record<string, unknown>): void {
  defaultInstance?.identify(userId, traits);
}

export function page(name?: string, properties?: Record<string, unknown>): void {
  defaultInstance?.page(name, properties);
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
} from './types';
export { createLogger } from './logger';
export type { Logger } from './logger';
