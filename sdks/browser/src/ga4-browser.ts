import { createLogger, type EventOptions } from '@alitycs/core';
import { BrowserAlitycs } from './index';
import { installGa4Bridge, type Ga4BridgeHandle, type Ga4BridgeMode } from './ga4';

interface Ga4ScriptConfiguration {
  apiKey: string;
  endpoint?: string;
  debug: boolean;
  mode: Ga4BridgeMode;
  dataLayerName: string;
  capturePageViews: boolean;
}

type GlobalApi = Record<string, unknown> & ((method: string, ...args: unknown[]) => unknown);

function booleanAttribute(script: HTMLScriptElement, name: string, fallback: boolean): boolean {
  const value = script.getAttribute(name);
  if (value === null) return fallback;
  return value !== 'false' && value !== '0';
}

function findScript(): HTMLScriptElement | null {
  if (typeof document === 'undefined') return null;
  if (typeof HTMLScriptElement !== 'undefined' && document.currentScript instanceof HTMLScriptElement) {
    return document.currentScript;
  }
  return document.querySelector<HTMLScriptElement>('script[data-api-key][src*="ga4"]');
}

function readConfiguration(script: HTMLScriptElement): Ga4ScriptConfiguration | null {
  const apiKey = script.getAttribute('data-api-key')?.trim();
  if (!apiKey) return null;
  const mode = script.getAttribute('data-ga4-mode') === 'replace' ? 'replace' : 'mirror';

  return {
    apiKey,
    endpoint: script.getAttribute('data-endpoint') ?? undefined,
    debug: booleanAttribute(script, 'data-debug', false),
    mode,
    dataLayerName: script.getAttribute('data-ga4-data-layer')?.trim() || 'dataLayer',
    capturePageViews: booleanAttribute(script, 'data-ga4-pageviews', true),
  };
}

function installGlobalApi(sdk: BrowserAlitycs, bridge: Ga4BridgeHandle, config: Ga4ScriptConfiguration): GlobalApi {
  const win = window as unknown as Record<string, unknown>;
  const api = Object.assign(
    function (method: string, ...args: unknown[]): unknown {
      const candidate = api[method];
      if (typeof candidate === 'function') return (candidate as (...methodArgs: unknown[]) => unknown)(...args);
      return api;
    },
    {
      track: (event: string, properties?: Record<string, unknown>, options?: EventOptions) => {
        sdk.track(event, properties, options);
        return api;
      },
      identify: (userId: string, traits?: Record<string, unknown>, options?: EventOptions) => {
        sdk.identify(userId, traits, options);
        return api;
      },
      reset: () => {
        sdk.reset();
        return api;
      },
      page: (name?: string, properties?: Record<string, unknown>, options?: EventOptions) => {
        sdk.page(name, properties, options);
        return api;
      },
      flush: () => sdk.flush(),
      shutdown: async () => {
        bridge.uninstall();
        await sdk.shutdown();
        if (win.alitycs === api) delete win.alitycs;
        if (win.AlitycsSDK === sdk) delete win.AlitycsSDK;
        if (win.AlitycsGA4 === bridge) delete win.AlitycsGA4;
      },
      setGlobalProperties: (properties: Record<string, unknown>) => {
        sdk.setGlobalProperties(properties);
        return api;
      },
      removeGlobalProperties: (keys: string[]) => {
        sdk.removeGlobalProperties(keys);
        return api;
      },
      clearGlobalProperties: () => {
        sdk.clearGlobalProperties();
        return api;
      },
      getGlobalProperties: () => sdk.getGlobalProperties(),
      _config: config,
      loaded: true,
    }
  ) as unknown as GlobalApi;
  win.alitycs = api;
  return api;
}

export function initializeGa4FromScript(script: HTMLScriptElement | null = findScript()): Ga4BridgeHandle | null {
  if (typeof window === 'undefined' || !script) return null;

  const win = window as unknown as Record<string, unknown>;
  const existing = win.AlitycsGA4;
  if (existing && typeof (existing as Ga4BridgeHandle).uninstall === 'function') {
    return existing as Ga4BridgeHandle;
  }

  const config = readConfiguration(script);
  const debug = booleanAttribute(script, 'data-debug', false);
  const logger = createLogger(debug);
  if (!config) {
    logger.error('API key not found');
    return null;
  }

  try {
    const sdk = BrowserAlitycs.init({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      debug: config.debug,
      autoCapture: false,
    });
    const bridge = installGa4Bridge(sdk, {
      mode: config.mode,
      dataLayerName: config.dataLayerName,
      capturePageViews: config.capturePageViews,
      debug: config.debug,
    });

    installGlobalApi(sdk, bridge, config);
    win.AlitycsSDK = sdk;
    win.AlitycsGA4 = bridge;
    return bridge;
  } catch (error) {
    logger.error('GA4 init failed:', error);
    return null;
  }
}

if (typeof window !== 'undefined') initializeGa4FromScript();

export { BrowserAlitycs, installGa4Bridge };
export type { Ga4BridgeHandle, Ga4BridgeMode };
