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
} from '@alitycs/core';
import type { BrowserConfig } from './types';
import { AutoCapture } from './auto-capture';

const BROWSER_DEFAULTS = {
  ...DEFAULTS,
  autoCapture: false,
};

export class BrowserAlitycs extends Alitycs {
  private autoCapture: AutoCapture | null = null;
  private beforeUnloadHandler: (() => void) | null = null;

  protected constructor(config: ResolvedConfig, browserConfig: BrowserConfig) {
    super(config);

    if (browserConfig.autoCapture) {
      this.autoCapture = new AutoCapture((name, props) => this.track(name, props));
      this.autoCapture.start();
    }

    if (typeof window !== 'undefined') {
      this.beforeUnloadHandler = () => {
        this.shutdown();
      };
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  static override init(config: BrowserConfig): BrowserAlitycs {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new Error('apiKey is required');
    }
    const resolved: ResolvedConfig = { ...BROWSER_DEFAULTS, ...config } as ResolvedConfig;
    return new BrowserAlitycs(resolved, config);
  }

  override async shutdown(): Promise<void> {
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
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

// Re-export core types + BrowserConfig
export { Alitycs };
export type { AlitycsConfig, ResolvedConfig, AnalyticsEvent, EventType, EventContext, BatchPayload, SessionData };
export type { BrowserConfig } from './types';
