import type { EventOptions } from '@alitycs/core';
import type { BrowserAlitycs } from './index';

export type Ga4BridgeMode = 'mirror' | 'replace';

export interface Ga4BridgeOptions {
  /** Keep Google Analytics active (`mirror`) or use Alitycs as the destination (`replace`). */
  mode?: Ga4BridgeMode;
  /** Name of the Google data layer. Defaults to `dataLayer`. */
  dataLayerName?: string;
  /** Capture GA page_view commands and automatic initial/SPA page views. Defaults to true. */
  capturePageViews?: boolean;
  /** Log dropped commands and replace-mode conflicts. */
  debug?: boolean;
}

export interface Ga4BridgeStats {
  captured: number;
  droppedForConsent: number;
  droppedInvalid: number;
  ignored: number;
}

export interface Ga4BridgeHandle {
  readonly mode: Ga4BridgeMode;
  getStats(): Ga4BridgeStats;
  uninstall(): void;
}

type Ga4Value = unknown;
type Ga4Params = Record<string, Ga4Value>;
type GtagFunction = (...args: unknown[]) => void;

interface BridgeSdk {
  track(eventName: string, properties?: Record<string, unknown>, options?: EventOptions): void;
  identify(userId: string, traits?: Record<string, unknown>, options?: EventOptions): void;
  page(name?: string, properties?: Record<string, unknown>, options?: EventOptions): void;
}

interface BridgeRegistration {
  handle: Ga4BridgeHandle;
}

const DEFAULT_DATA_LAYER = 'dataLayer';
const MAX_USER_PROPERTIES = 46;
const MAX_PROPERTY_KEY_LENGTH = 100;
const MAX_PROPERTY_VALUE_LENGTH = 1000;
const PAGE_VIEW_DEDUPE_MS = 1000;
const BRIDGE_MARKER = Symbol.for('alitycs.ga4.bridge');
const GTAG_SHIM_MARKER = Symbol.for('alitycs.ga4.gtag-shim');
const CONTROL_PARAMETERS = new Set(['event_callback', 'event_timeout', 'send_page_view']);

function isRecord(value: unknown): value is Ga4Params {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toParams(value: unknown): Ga4Params {
  return isRecord(value) ? { ...value } : {};
}

function toCommand(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return null;

  const candidate = value as { 0?: unknown; length?: unknown };
  if (typeof candidate[0] !== 'string' || typeof candidate.length !== 'number') return null;

  try {
    return Array.from(value as ArrayLike<unknown>);
  } catch {
    return null;
  }
}

function targetList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap(item => (typeof item === 'string' ? item.split(/[\s,]+/) : []))
    .map(item => item.trim())
    .filter(Boolean);
}

function isGaTarget(target: string): boolean {
  return target.startsWith('G-') || target.startsWith('GT-');
}

function isAdsTarget(target: string): boolean {
  return target.startsWith('AW-') || target.startsWith('DC-');
}

function defer(callback: () => void): void {
  if (typeof queueMicrotask === 'function') queueMicrotask(callback);
  else void Promise.resolve().then(callback);
}

function serializedLength(value: unknown): number | null {
  try {
    if (value === undefined) return 0;
    if (typeof value === 'string') return value.length;
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    const serialized = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    return serialized === undefined ? null : serialized.length;
  } catch {
    return null;
  }
}

/**
 * Installs a GA4-compatible dataLayer/gtag bridge for an Alitycs browser SDK instance.
 * Existing dataLayer entries are replayed once before future pushes are observed.
 */
export function installGa4Bridge(sdk: BrowserAlitycs, options: Ga4BridgeOptions = {}): Ga4BridgeHandle {
  if (typeof window === 'undefined') {
    throw new Error('installGa4Bridge() requires a browser environment');
  }

  const bridgeSdk = sdk as BridgeSdk;
  const win = window as unknown as Window & Record<string | symbol, unknown>;
  const mode: Ga4BridgeMode = options.mode === 'replace' ? 'replace' : 'mirror';
  const dataLayerName = options.dataLayerName?.trim() || DEFAULT_DATA_LAYER;
  const capturePageViews = options.capturePageViews !== false;
  const debug = options.debug === true;
  const existingLayer = win[dataLayerName];
  const dataLayer: unknown[] = Array.isArray(existingLayer) ? existingLayer : [];
  if (!Array.isArray(existingLayer)) win[dataLayerName] = dataLayer;

  const existingRegistration = (dataLayer as unknown as Record<symbol, unknown>)[BRIDGE_MARKER] as
    BridgeRegistration | undefined;
  if (existingRegistration) return existingRegistration.handle;

  const stats: Ga4BridgeStats = {
    captured: 0,
    droppedForConsent: 0,
    droppedInvalid: 0,
    ignored: 0,
  };
  const globalParameters: Ga4Params = {};
  const dataLayerState: Ga4Params = {};
  const targetConfigurations = new Map<string, Ga4Params>();
  const sendPageViewByTarget = new Map<string, boolean>();
  let analyticsStorageGranted = true;
  let uninstalled = false;
  let lastIdentifiedUserId: string | undefined;
  let lastPageLocation: string | undefined;
  let lastPageTimestamp = 0;
  let initialPageTimer: ReturnType<typeof setTimeout> | undefined;

  const warn = (...args: unknown[]): void => {
    if (debug && typeof console !== 'undefined') console.warn('[Alitycs GA4]', ...args);
  };

  const selectedAutomaticTarget = (): string | undefined => {
    for (const target of targetConfigurations.keys()) {
      if (sendPageViewByTarget.get(target) !== false) return target;
    }
    return undefined;
  };

  const automaticPageViewsEnabled = (): boolean => {
    if (!capturePageViews) return false;
    if (targetConfigurations.size === 0) return true;
    return selectedAutomaticTarget() !== undefined;
  };

  const identifyUser = (userId: unknown): void => {
    if (typeof userId !== 'string' && typeof userId !== 'number') return;
    const normalized = String(userId).trim();
    if (!normalized || normalized === lastIdentifiedUserId) return;
    if (!analyticsStorageGranted) return;

    bridgeSdk.identify(normalized, {
      alitycs_integration: 'ga4',
      ga4_bridge_mode: mode,
    });
    lastIdentifiedUserId = normalized;
  };

  const chooseTarget = (parameters: Ga4Params): { target?: string; adsOnly: boolean } => {
    const destinations = targetList(parameters.send_to);
    const gaTarget = destinations.find(isGaTarget);
    if (gaTarget) return { target: gaTarget, adsOnly: false };
    if (destinations.length > 0 && destinations.every(isAdsTarget)) return { adsOnly: true };
    return { target: selectedAutomaticTarget() ?? targetConfigurations.keys().next().value, adsOnly: false };
  };

  const mergedParameters = (eventParameters: Ga4Params, target?: string): Ga4Params => ({
    ...dataLayerState,
    ...globalParameters,
    ...(target ? targetConfigurations.get(target) : undefined),
    ...eventParameters,
  });

  const sanitizeProperties = (eventParameters: Ga4Params, target?: string): Record<string, unknown> => {
    const targetParameters = target ? (targetConfigurations.get(target) ?? {}) : {};
    const sources = [eventParameters, targetParameters, globalParameters, dataLayerState];
    const selected = new Map<string, unknown>();
    let dropped = 0;

    for (const source of sources) {
      for (const [key, value] of Object.entries(source)) {
        if (selected.has(key) || CONTROL_PARAMETERS.has(key) || key.startsWith('gtm.')) continue;
        if (selected.size >= MAX_USER_PROPERTIES || key.length > MAX_PROPERTY_KEY_LENGTH) {
          dropped += 1;
          continue;
        }

        const valueLength = serializedLength(value);
        if (valueLength === null || valueLength > MAX_PROPERTY_VALUE_LENGTH) {
          dropped += 1;
          continue;
        }
        if (value !== undefined) selected.set(key, value);
      }
    }

    if (dropped > 0) {
      stats.droppedInvalid += dropped;
      warn(`Dropped ${dropped} invalid or excess GA4 parameter(s)`);
    }

    const properties: Record<string, unknown> = Object.fromEntries(selected);
    properties.alitycs_integration = 'ga4';
    properties.ga4_bridge_mode = mode;
    if (target) properties.ga4_target_id = target;
    if (dropped > 0) properties.ga4_dropped_property_count = dropped;
    return properties;
  };

  const pageContext = (): Ga4Params => ({
    page_location: win.location?.href,
    page_title: win.document?.title || undefined,
    page_referrer: win.document?.referrer || undefined,
  });

  const emit = (eventName: string, eventParameters: Ga4Params, automatic = false): boolean => {
    if (uninstalled) return false;
    if (!analyticsStorageGranted) {
      stats.droppedForConsent += 1;
      warn(`Dropped ${eventName}: analytics_storage is denied`);
      return false;
    }
    if (!eventName || eventName.startsWith('gtm.')) {
      stats.ignored += 1;
      return false;
    }

    const { target, adsOnly } = chooseTarget(eventParameters);
    if (adsOnly) {
      stats.ignored += 1;
      return false;
    }

    const combined = mergedParameters(eventParameters, target);
    identifyUser(combined.user_id);
    const properties = sanitizeProperties(eventParameters, target);

    if (eventName === 'page_view') {
      if (automatic && !automaticPageViewsEnabled()) return false;
      const location = typeof combined.page_location === 'string' ? combined.page_location : win.location?.href;
      const now = Date.now();
      if (location && location === lastPageLocation && now - lastPageTimestamp < PAGE_VIEW_DEDUPE_MS) {
        stats.ignored += 1;
        return false;
      }
      lastPageLocation = location;
      lastPageTimestamp = now;
      bridgeSdk.page('page_view', properties, {
        dedupeKey: `ga4:page_view:${location ?? ''}`,
        dedupeWindowMs: PAGE_VIEW_DEDUPE_MS,
      });
    } else {
      bridgeSdk.track(eventName, properties);
    }

    stats.captured += 1;
    return true;
  };

  const emitAutomaticPageView = (target?: string, overrides: Ga4Params = {}): void => {
    if (!automaticPageViewsEnabled()) return;
    emit(
      'page_view',
      {
        ...pageContext(),
        ...(target ? { send_to: target } : {}),
        ...overrides,
      },
      true
    );
  };

  const invokeCallback = (callback: unknown, value?: unknown): void => {
    if (typeof callback !== 'function') return;
    defer(() => {
      try {
        (callback as (result?: unknown) => void)(value);
      } catch (error) {
        warn('GA callback threw an error', error);
      }
    });
  };

  const processCommand = (command: unknown[]): void => {
    const name = command[0];
    if (typeof name !== 'string') {
      stats.ignored += 1;
      return;
    }

    if (name === 'js') {
      stats.ignored += 1;
      return;
    }

    if (name === 'set') {
      const values = typeof command[1] === 'string' ? { [command[1]]: command[2] } : toParams(command[1]);
      Object.assign(globalParameters, values);
      identifyUser(values.user_id);
      return;
    }

    if (name === 'config') {
      const target = typeof command[1] === 'string' ? command[1] : '';
      if (!isGaTarget(target)) {
        stats.ignored += 1;
        return;
      }

      const values = toParams(command[2]);
      const current = targetConfigurations.get(target) ?? {};
      targetConfigurations.set(target, { ...current, ...values });
      sendPageViewByTarget.set(target, values.send_page_view !== false);
      identifyUser(values.user_id);
      if (values.send_page_view !== false) emitAutomaticPageView(target, values);
      return;
    }

    if (name === 'event') {
      const eventName = typeof command[1] === 'string' ? command[1] : '';
      const values = toParams(command[2]);
      emit(eventName, values);
      if (mode === 'replace') invokeCallback(values.event_callback);
      return;
    }

    if (name === 'get') {
      if (mode !== 'replace') return;
      const target = typeof command[1] === 'string' ? command[1] : '';
      const field = typeof command[2] === 'string' ? command[2] : '';
      const callback = command[3];
      const value = targetConfigurations.get(target)?.[field] ?? globalParameters[field] ?? dataLayerState[field];
      invokeCallback(callback, value);
      return;
    }

    if (name === 'consent') {
      const values = toParams(command[2]);
      if (!Object.prototype.hasOwnProperty.call(values, 'analytics_storage')) return;
      const wasGranted = analyticsStorageGranted;
      analyticsStorageGranted = values.analytics_storage !== 'denied';
      if (!wasGranted && analyticsStorageGranted) {
        identifyUser(globalParameters.user_id);
        emitAutomaticPageView();
      }
      return;
    }

    stats.ignored += 1;
  };

  const processItem = (item: unknown): void => {
    try {
      const command = toCommand(item);
      if (command) {
        processCommand(command);
        return;
      }

      if (!isRecord(item)) {
        stats.ignored += 1;
        return;
      }

      const eventName = typeof item.event === 'string' ? item.event : undefined;
      const values = { ...item };
      delete values.event;
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith('gtm.')) dataLayerState[key] = value;
      }
      identifyUser(values.user_id);
      if (eventName) emit(eventName, values);
    } catch (error) {
      stats.droppedInvalid += 1;
      warn('Ignored an invalid dataLayer item', error);
    }
  };

  const originalPush = dataLayer.push;
  const patchedPush = function (this: unknown[], ...items: unknown[]): number {
    const length = originalPush.apply(dataLayer, items);
    for (const item of items) processItem(item);
    return length;
  };
  dataLayer.push = patchedPush;

  const historyObject = win.history;
  const originalPushState = historyObject?.pushState;
  const originalReplaceState = historyObject?.replaceState;
  let patchedPushState: History['pushState'] | undefined;
  let patchedReplaceState: History['replaceState'] | undefined;
  const handleNavigation = (): void => defer(() => emitAutomaticPageView());
  if (capturePageViews && historyObject) {
    if (originalPushState) {
      patchedPushState = function (...args: Parameters<History['pushState']>): void {
        originalPushState.apply(historyObject, args);
        handleNavigation();
      };
      historyObject.pushState = patchedPushState;
    }
    if (originalReplaceState) {
      patchedReplaceState = function (...args: Parameters<History['replaceState']>): void {
        originalReplaceState.apply(historyObject, args);
        handleNavigation();
      };
      historyObject.replaceState = patchedReplaceState;
    }
    win.addEventListener('popstate', handleNavigation);
  }

  const originalGtag = win.gtag as GtagFunction | undefined;
  let createdGtag: GtagFunction | undefined;
  if (mode === 'replace' && typeof originalGtag !== 'function') {
    createdGtag = (...args: unknown[]) => {
      dataLayer.push(args);
    };
    (createdGtag as unknown as Record<symbol, unknown>)[GTAG_SHIM_MARKER] = true;
    win.gtag = createdGtag;
  }

  const handle: Ga4BridgeHandle = {
    mode,
    getStats: () => ({ ...stats }),
    uninstall: () => {
      if (uninstalled) return;
      uninstalled = true;
      if (initialPageTimer !== undefined) clearTimeout(initialPageTimer);
      if (dataLayer.push === patchedPush) dataLayer.push = originalPush;
      if (capturePageViews && historyObject) {
        if (historyObject.pushState === patchedPushState && originalPushState)
          historyObject.pushState = originalPushState;
        if (historyObject.replaceState === patchedReplaceState && originalReplaceState) {
          historyObject.replaceState = originalReplaceState;
        }
        win.removeEventListener('popstate', handleNavigation);
      }
      if (createdGtag && win.gtag === createdGtag) {
        if (originalGtag) win.gtag = originalGtag;
        else delete win.gtag;
      }
      delete (dataLayer as unknown as Record<symbol, unknown>)[BRIDGE_MARKER];
    },
  };

  (dataLayer as unknown as Record<symbol, unknown>)[BRIDGE_MARKER] = { handle } satisfies BridgeRegistration;

  for (const item of [...dataLayer]) processItem(item);
  if (capturePageViews) initialPageTimer = setTimeout(() => emitAutomaticPageView(), 0);

  if (mode === 'replace') {
    const googleScripts = win.document?.querySelectorAll?.(
      'script[src*="googletagmanager.com/gtag/js"],script[src*="google-analytics.com"]'
    );
    if ((googleScripts?.length ?? 0) > 0 || Boolean(win.google_tag_manager)) {
      warn('Google Analytics appears to be active. Replace mode does not block Google scripts or GTM tags.');
    }
  }

  return handle;
}
