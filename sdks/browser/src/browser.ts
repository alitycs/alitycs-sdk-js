import { BrowserAlitycs } from './index';
import { createLogger } from '@alitycs/core';
import type { BrowserConfig } from './types';

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
    const sdk = BrowserAlitycs.init(sdkConfig);

    // Process queued calls
    const queue = stub._queue || [];
    for (const call of queue) {
      try {
        // Skip bare page() calls when autoCapture is on — autoCapture fires its own $pageview
        // Custom page('Name', {...}) calls are preserved since they carry user intent
        if (sdkConfig.autoCapture && call.method === 'page' && !call.args[0]) continue;
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
        if (method === 'track') sdk.track(args[0] as string, args[1] as Record<string, unknown>);
        else if (method === 'identify') sdk.identify(args[0] as string, args[1] as Record<string, unknown>);
        else if (method === 'page') sdk.page(args[0] as string, args[1] as Record<string, unknown>);
        else if (method === 'setGlobalProperties') sdk.setGlobalProperties(args[0] as Record<string, unknown>);
        else if (method === 'removeGlobalProperties') sdk.removeGlobalProperties(args[0] as string[]);
        else if (method === 'clearGlobalProperties') sdk.clearGlobalProperties();
        return win.alitycs;
      },
      {} as Record<string, unknown>
    );

    api.track = (event: string, properties?: Record<string, unknown>) => {
      sdk.track(event, properties);
      return win.alitycs;
    };
    api.identify = (userId: string, traits?: Record<string, unknown>) => {
      sdk.identify(userId, traits);
      return win.alitycs;
    };
    api.page = (name?: string, properties?: Record<string, unknown>) => {
      sdk.page(name, properties);
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
