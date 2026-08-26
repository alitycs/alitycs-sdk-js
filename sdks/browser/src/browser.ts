import { BrowserAlitycs } from './index';
import { createLogger, type EventOptions } from '@alitycs/core';
import type { BrowserConfig } from './types';
import type { CapturedPage } from './auto-capture';

interface SnippetStub {
  _queue: Array<{ method: string; args: unknown[]; timestamp: number }>;
  _config: {
    apiKey: string;
    sdkUrl?: string;
    autoTrack?: boolean;
    autoCapture?: boolean;
    debug?: boolean;
    endpoint?: string;
  };
  loaded: boolean;
  [key: string]: unknown;
}

/** Queued snippet calls may only replay onto this public API surface — never internals or shutdown. */
const REPLAYABLE_METHODS = new Set([
  'track',
  'captureError',
  'identify',
  'reset',
  'page',
  'setGlobalProperties',
  'removeGlobalProperties',
  'clearGlobalProperties',
]);

function initializeFromSnippet(): void {
  if (typeof window === 'undefined') return;

  const stub = (window as unknown as Record<string, unknown>).alitycs as SnippetStub | undefined;
  if (!stub || stub.loaded) return;

  const snippetConfig = stub._config;
  const logger = createLogger(snippetConfig?.debug ?? false);
  if (!snippetConfig?.apiKey) {
    logger.error('API key not found in snippet configuration');
    return;
  }

  const sdkConfig: BrowserConfig = {
    apiKey: snippetConfig.apiKey,
    endpoint: snippetConfig.endpoint,
    autoCapture: snippetConfig.autoCapture ?? false,
    debug: snippetConfig.debug ?? false,
  };

  try {
    const queue = stub._queue || [];
    let initialPageIndex = -1;
    let initialPage: CapturedPage | undefined;
    if (sdkConfig.autoCapture) {
      for (let index = queue.length - 1; index >= 0; index--) {
        const call = queue[index];
        const properties = call?.method === 'page' ? call.args[1] : undefined;
        if (!call?.args[0] && properties && typeof properties === 'object') {
          const url = (properties as Record<string, unknown>).url;
          if (typeof url === 'string' && url) {
            initialPageIndex = index;
            initialPage = {
              capturedAt: call.timestamp,
              properties: properties as Record<string, unknown>,
            };
            break;
          }
        }
      }
    }
    const sdk = BrowserAlitycs.init(sdkConfig, initialPage);

    // Process queued calls
    for (const [index, call] of queue.entries()) {
      try {
        if (index === initialPageIndex) continue;
        // Skip bare page() calls when autoCapture is on — autoCapture calls page() for the initial document.
        // Custom page('Name', {...}) calls are preserved since they carry user intent
        if (sdkConfig.autoCapture && call.method === 'page' && !call.args[0]) continue;
        if (!REPLAYABLE_METHODS.has(call.method)) {
          logger.warn('Ignoring unsupported queued call:', call.method);
          continue;
        }
        const method = call.method as keyof BrowserAlitycs;
        if (typeof sdk[method] === 'function') {
          const fn = sdk[method] as (...args: unknown[]) => unknown;
          fn.call(sdk, ...call.args);
        }
      } catch (err) {
        logger.warn('Error processing queued call:', err);
      }
    }
    stub._queue = [];

    // Replace stub with real SDK methods
    const win = window as unknown as Record<string, unknown>;
    const api: Record<string, unknown> = Object.assign(
      function (method: string, ...args: unknown[]) {
        if (method === 'track')
          sdk.track(args[0] as string, args[1] as Record<string, unknown>, args[2] as EventOptions);
        else if (method === 'captureError')
          sdk.captureError(args[0] as string, args[1] as Record<string, unknown>, args[2] as EventOptions);
        else if (method === 'identify')
          sdk.identify(args[0] as string, args[1] as Record<string, unknown>, args[2] as EventOptions);
        else if (method === 'reset') sdk.reset();
        else if (method === 'page')
          sdk.page(args[0] as string, args[1] as Record<string, unknown>, args[2] as EventOptions);
        else if (method === 'setGlobalProperties') sdk.setGlobalProperties(args[0] as Record<string, unknown>);
        else if (method === 'removeGlobalProperties') sdk.removeGlobalProperties(args[0] as string[]);
        else if (method === 'clearGlobalProperties') sdk.clearGlobalProperties();
        return win.alitycs;
      },
      {} as Record<string, unknown>
    );

    api.track = (event: string, properties?: Record<string, unknown>, options?: EventOptions) => {
      sdk.track(event, properties, options);
      return win.alitycs;
    };
    api.captureError = (errorName: string, properties?: Record<string, unknown>, options?: EventOptions) => {
      sdk.captureError(errorName, properties, options);
      return win.alitycs;
    };
    api.identify = (userId: string, traits?: Record<string, unknown>, options?: EventOptions) => {
      sdk.identify(userId, traits, options);
      return win.alitycs;
    };
    api.reset = () => {
      sdk.reset();
      return win.alitycs;
    };
    api.page = (name?: string, properties?: Record<string, unknown>, options?: EventOptions) => {
      sdk.page(name, properties, options);
      return win.alitycs;
    };
    api.flush = () => sdk.flush();
    api.shutdown = () => sdk.shutdown();
    api.setGlobalProperties = (properties: Record<string, unknown>) => {
      sdk.setGlobalProperties(properties);
      return win.alitycs;
    };
    api.removeGlobalProperties = (keys: string[]) => {
      sdk.removeGlobalProperties(keys);
      return win.alitycs;
    };
    api.clearGlobalProperties = () => {
      sdk.clearGlobalProperties();
      return win.alitycs;
    };
    api.getGlobalProperties = () => sdk.getGlobalProperties();
    api._config = stub._config;
    api._queue = stub._queue;
    api.loaded = true;

    win.alitycs = api;
    win.AlitycsSDK = sdk;

    logger.warn('SDK ready. Queue processed:', queue.length, 'calls');
  } catch (error) {
    logger.error('Failed to initialize SDK:', error);
  }
}

// Auto-initialize when script loads
if (typeof window !== 'undefined') {
  setTimeout(initializeFromSnippet, 0);
}

export { initializeFromSnippet, BrowserAlitycs };
