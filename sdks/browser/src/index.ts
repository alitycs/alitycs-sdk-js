import {
  Alitycs,
  resolveAlitycsConfig,
  type AlitycsConfig,
  type ResolvedConfig,
  type AnalyticsEvent,
  type EventType,
  type EventContext,
  type BatchPayload,
  type SessionData,
  type EventOptions,
  type FlushResult,
  type ReservedEventName,
} from '@alitycs/core';
import type { BrowserConfig } from './types';
import { AutoCapture, type CapturedPage } from './auto-capture';

/**
 * Auto-captured page views share the GA4 bridge's `ga4:page_view:<location>` dedupe key so a
 * single navigation produces exactly one event when the bridge, autoCapture, or both are enabled.
 */
const PAGE_VIEW_DEDUPE_MS = 1000;

function pageViewDedupeOptions(url: unknown): EventOptions | undefined {
  return typeof url === 'string' && url
    ? { dedupeKey: `ga4:page_view:${url}`, dedupeWindowMs: PAGE_VIEW_DEDUPE_MS }
    : undefined;
}

export class BrowserAlitycs extends Alitycs {
  private autoCapture: AutoCapture | null = null;
  private pageHideHandler: EventListener | null = null;
  private visibilityChangeHandler: EventListener | null = null;
  private pageShowHandler: EventListener | null = null;
  private beforeUnloadHandler: EventListener | null = null;
  private lastExitGeneration = -1;
  private lastExitAt = 0;

  protected constructor(config: ResolvedConfig, browserConfig: BrowserConfig, initialPage?: CapturedPage) {
    super(config);

    if (browserConfig.autoCapture) {
      this.autoCapture = new AutoCapture(
        (name, props) => this.track(name, props),
        (props, capturedAt) => {
          const options = pageViewDedupeOptions(props.url);
          if (capturedAt === undefined) this.page(undefined, props, options);
          else this.pageAt(capturedAt, undefined, props, options);
        }
      );
      this.autoCapture.start(initialPage);
    }

    if (typeof window !== 'undefined') {
      this.pageHideHandler = () => this.flushOnExit();
      window.addEventListener('pagehide', this.pageHideHandler);
      this.pageShowHandler = event => {
        if ((event as PageTransitionEvent).persisted) {
          this.rearmAfterPageShow();
          this.lastExitGeneration = -1;
          if (this.hasPendingDelivery) this.armBeforeUnload();
        }
      };
      window.addEventListener('pageshow', this.pageShowHandler);
    }

    if (typeof document !== 'undefined') {
      this.visibilityChangeHandler = () => {
        if (document.visibilityState === 'hidden') this.flushOnExit();
      };
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
    }
  }

  static override init(config: BrowserConfig, initialPage?: CapturedPage): BrowserAlitycs {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('apiKey is required');
    }
    const resolved: ResolvedConfig = resolveAlitycsConfig(config);
    return new BrowserAlitycs(resolved, config, initialPage);
  }

  override async shutdown(): Promise<FlushResult> {
    if (this.pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }
    if (this.pageShowHandler && typeof window !== 'undefined') {
      window.removeEventListener('pageshow', this.pageShowHandler);
      this.pageShowHandler = null;
    }
    this.disarmBeforeUnload();
    this.autoCapture?.stop();
    return super.shutdown();
  }

  protected override onEventAccepted(): void {
    this.armBeforeUnload();
  }

  protected override onDeliveryStateChanged(): void {
    if (!this.hasPendingDelivery) this.disarmBeforeUnload();
  }

  private flushOnExit(): void {
    this.saveNowForPageExit();
    const generation = this.deliveryGeneration;
    const dirty = generation !== this.lastExitGeneration;
    const pending = this.hasPendingDelivery;
    const now = Date.now();

    // Empty lifecycle notifications are intentionally cheap. A pending batch or a new accepted
    // event always wins over this guard, so visibilitychange → pagehide remains dirty-aware.
    if (!dirty && !pending && now - this.lastExitAt < 1_000) return;
    if (!dirty && !pending) return;

    this.lastExitGeneration = generation;
    this.lastExitAt = now;
    void this.flushForPageExit().then(result => {
      if (result.status === 'drained' && generation === this.deliveryGeneration) this.disarmBeforeUnload();
    });
  }

  private armBeforeUnload(): void {
    if (this.beforeUnloadHandler || typeof window === 'undefined') return;
    this.beforeUnloadHandler = () => this.flushOnExit();
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }

  private disarmBeforeUnload(): void {
    if (!this.beforeUnloadHandler || typeof window === 'undefined') return;
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.beforeUnloadHandler = null;
  }
}

// --- Module-level convenience (optional default instance) ---

let defaultInstance: BrowserAlitycs | undefined;

export function init(config: BrowserConfig): BrowserAlitycs {
  defaultInstance = BrowserAlitycs.init(config);
  return defaultInstance;
}

export function track(eventName: string, properties?: Record<string, unknown>, options?: EventOptions): void {
  defaultInstance?.track(eventName, properties, options);
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

export function flush(): Promise<FlushResult> {
  return defaultInstance?.flush() ?? Promise.resolve({ status: 'drained', delivered: 0, pending: 0 });
}

export function shutdown(): Promise<FlushResult> {
  const result = defaultInstance?.shutdown() ?? Promise.resolve({ status: 'drained', delivered: 0, pending: 0 });
  defaultInstance = undefined;
  return result;
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

// Re-export core types + BrowserConfig
export { Alitycs };
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
};
export type { BrowserConfig } from './types';
