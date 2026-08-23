import {
  Alitycs,
  DEFAULTS,
  type AlitycsConfig,
  type ResolvedConfig,
  type AnalyticsEvent,
  type EventType,
  type EventContext,
  type BatchPayload,
  type SessionData,
  type EventOptions,
} from '@alitycs/core';
import type { BrowserConfig } from './types';
import { AutoCapture, type CapturedPage } from './auto-capture';

const BROWSER_DEFAULTS = {
  ...DEFAULTS,
  autoCapture: false,
};

export class BrowserAlitycs extends Alitycs {
  private autoCapture: AutoCapture | null = null;
  private pageHideHandler: EventListener | null = null;
  private visibilityChangeHandler: EventListener | null = null;

  protected constructor(config: ResolvedConfig, browserConfig: BrowserConfig, initialPage?: CapturedPage) {
    super(config);

    if (browserConfig.autoCapture) {
      this.autoCapture = new AutoCapture(
        (name, props) => this.track(name, props),
        (props, capturedAt) =>
          capturedAt === undefined ? this.page(undefined, props) : this.pageAt(capturedAt, undefined, props)
      );
      this.autoCapture.start(initialPage);
    }

    if (typeof window !== 'undefined') {
      this.pageHideHandler = () => this.flushForPageExit();
      window.addEventListener('pagehide', this.pageHideHandler);
    }

    if (typeof document !== 'undefined') {
      this.visibilityChangeHandler = () => {
        if (document.visibilityState === 'hidden') this.flushForPageExit();
      };
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
    }
  }

  static override init(config: BrowserConfig, initialPage?: CapturedPage): BrowserAlitycs {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('apiKey is required');
    }
    const resolved: ResolvedConfig = { ...BROWSER_DEFAULTS, ...config } as ResolvedConfig;
    return new BrowserAlitycs(resolved, config, initialPage);
  }

  override async shutdown(): Promise<void> {
    if (this.pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageHideHandler);
      this.pageHideHandler = null;
    }
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }
    this.autoCapture?.stop();
    await super.shutdown();
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

// Re-export core types + BrowserConfig
export { Alitycs };
export type {
  AlitycsConfig,
  ResolvedConfig,
  AnalyticsEvent,
  EventType,
  EventContext,
  BatchPayload,
  SessionData,
  EventOptions,
};
export type { BrowserConfig } from './types';
