import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { EventOptions } from '@alitycs/core';
import type { BrowserAlitycs } from '../../src';
import { installGa4Bridge, type Ga4BridgeHandle } from '../../src/ga4';

interface CapturedCall {
  name: string;
  properties?: Record<string, unknown>;
  options?: EventOptions;
}

function commandArguments(..._args: unknown[]): IArguments {
  // gtag queues the function's Arguments object, not a normal array.
  // eslint-disable-next-line prefer-rest-params
  return arguments;
}

describe('installGa4Bridge', () => {
  let originalWindow: unknown;
  let originalDocument: unknown;
  let fakeWindow: any;
  let handles: Ga4BridgeHandle[];
  let tracks: CapturedCall[];
  let pages: CapturedCall[];
  let identifies: CapturedCall[];
  let sdk: BrowserAlitycs;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;
    handles = [];
    tracks = [];
    pages = [];
    identifies = [];

    const events = new EventTarget();
    const location = { href: 'https://example.test/start', pathname: '/start' };
    const document = {
      title: 'Example',
      referrer: 'https://referrer.test/',
      querySelectorAll: mock(() => []),
    };
    const history = {
      pushState: mock((_state: unknown, _unused: string, url?: string | URL | null) => {
        if (url) location.href = new URL(String(url), location.href).href;
      }),
      replaceState: mock((_state: unknown, _unused: string, url?: string | URL | null) => {
        if (url) location.href = new URL(String(url), location.href).href;
      }),
    };
    fakeWindow = {
      location,
      document,
      history,
      dataLayer: [],
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    (globalThis as any).window = fakeWindow;
    (globalThis as any).document = document;

    sdk = {
      track: (name: string, properties?: Record<string, unknown>, options?: EventOptions) => {
        tracks.push({ name, properties, options });
      },
      page: (name?: string, properties?: Record<string, unknown>, options?: EventOptions) => {
        pages.push({ name: name ?? 'page_view', properties, options });
      },
      identify: (userId: string, traits?: Record<string, unknown>, options?: EventOptions) => {
        identifies.push({ name: userId, properties: traits, options });
      },
    } as unknown as BrowserAlitycs;
  });

  afterEach(() => {
    for (const handle of handles) handle.uninstall();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  function install(options: Parameters<typeof installGa4Bridge>[1] = {}): Ga4BridgeHandle {
    const handle = installGa4Bridge(sdk, options);
    handles.push(handle);
    return handle;
  }

  test('replays queued Arguments objects and applies GA parameter precedence', () => {
    fakeWindow.dataLayer.push(
      commandArguments('set', { currency: 'USD', shared: 'global' }),
      commandArguments('config', 'G-TEST', { shared: 'config', campaign: 'spring', send_page_view: false }),
      commandArguments('event', 'purchase', { shared: 'event', value: 29, user_id: 'user-7' })
    );

    const handle = install({ capturePageViews: false });

    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe('purchase');
    expect(tracks[0].properties).toMatchObject({
      currency: 'USD',
      campaign: 'spring',
      shared: 'event',
      value: 29,
      alitycs_integration: 'ga4',
      ga4_bridge_mode: 'mirror',
      ga4_target_id: 'G-TEST',
    });
    expect(identifies.map(call => call.name)).toEqual(['user-7']);
    expect(handle.getStats().captured).toBe(1);
  });

  test('preserves push return values and emits one event for multiple GA destinations', () => {
    const handle = install({ capturePageViews: false });
    const result = fakeWindow.dataLayer.push(['event', 'signup', { send_to: 'G-ONE G-TWO', method: 'email' }]);
    fakeWindow.dataLayer.push(['event', 'conversion', { send_to: 'AW-123/DC-456' }]);

    expect(result).toBe(1);
    expect(fakeWindow.dataLayer).toHaveLength(2);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe('signup');
    expect(tracks[0].properties?.ga4_target_id).toBe('G-ONE');
    expect(handle.getStats().ignored).toBe(1);
  });

  test('honors analytics_storage denial without buffering and emits current page on grant', async () => {
    fakeWindow.dataLayer.push(
      ['consent', 'default', { analytics_storage: 'denied' }],
      ['event', 'denied_event', { value: 1 }]
    );
    const handle = install();

    expect(tracks).toHaveLength(0);
    expect(handle.getStats().droppedForConsent).toBe(1);

    fakeWindow.dataLayer.push(['consent', 'update', { analytics_storage: 'granted' }]);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(pages).toHaveLength(1);

    fakeWindow.dataLayer.push(['event', 'allowed_event', { value: 2 }]);
    expect(tracks.map(call => call.name)).toEqual(['allowed_event']);
    expect(tracks.some(call => call.name === 'denied_event')).toBe(false);
  });

  test('creates replace-mode gtag, resolves get/callback asynchronously, and cleans up', async () => {
    const originalPush = fakeWindow.dataLayer.push;
    const originalHistoryPush = fakeWindow.history.pushState;
    const handle = install({ mode: 'replace', capturePageViews: false });
    const getCallback = mock((_value?: unknown) => {});
    const eventCallback = mock(() => {});

    expect(typeof fakeWindow.gtag).toBe('function');
    fakeWindow.gtag('set', { currency: 'EUR' });
    fakeWindow.gtag('get', 'G-TEST', 'currency', getCallback);
    fakeWindow.gtag('event', 'checkout', { event_callback: eventCallback, event_timeout: 1000 });
    await Promise.resolve();

    expect(getCallback).toHaveBeenCalledWith('EUR');
    expect(eventCallback).toHaveBeenCalledTimes(1);
    expect(tracks[0].properties).not.toHaveProperty('event_callback');
    expect(tracks[0].properties).not.toHaveProperty('event_timeout');

    handle.uninstall();
    expect(fakeWindow.gtag).toBeUndefined();
    expect(fakeWindow.dataLayer.push).toBe(originalPush);
    expect(fakeWindow.history.pushState).toBe(originalHistoryPush);
  });

  test('merges persistent object state and ignores GTM internal events', () => {
    install({ capturePageViews: false });
    fakeWindow.dataLayer.push({ currency: 'GBP', app_version: '2' });
    fakeWindow.dataLayer.push({ event: 'gtm.dom', 'gtm.start': Date.now() });
    fakeWindow.dataLayer.push({ event: 'purchase', value: 10 });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      name: 'purchase',
      properties: { currency: 'GBP', app_version: '2', value: 10 },
    });
    expect(tracks[0].properties).not.toHaveProperty('gtm.start');
  });

  test('caps user parameters so bridge metadata stays within the Worker limit', () => {
    const parameters: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [`parameter_${index}`, index])
    );
    parameters.send_to = 'G-LIMIT';
    parameters.invalid_value = 'x'.repeat(1001);
    const handle = install({ capturePageViews: false, debug: true });

    fakeWindow.dataLayer.push(['event', 'large_event', parameters]);

    expect(tracks).toHaveLength(1);
    expect(Object.keys(tracks[0].properties ?? {})).toHaveLength(50);
    expect(tracks[0].properties?.parameter_0).toBe(0);
    expect(tracks[0].properties?.parameter_50).toBeUndefined();
    expect(tracks[0].properties?.ga4_dropped_property_count).toBeGreaterThan(0);
    expect(handle.getStats().droppedInvalid).toBeGreaterThan(0);
  });

  test('captures initial and SPA page views once per URL within the dedupe window', async () => {
    const originalPush = fakeWindow.history.pushState;
    const handle = install();
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      name: 'page_view',
      properties: { page_location: 'https://example.test/start', alitycs_integration: 'ga4' },
    });

    fakeWindow.history.pushState({}, '', '/next');
    await Promise.resolve();
    expect(pages).toHaveLength(2);
    expect(pages[1].properties?.page_location).toBe('https://example.test/next');

    fakeWindow.history.replaceState({}, '', '/next');
    fakeWindow.dataLayer.push(['event', 'page_view', { page_location: 'https://example.test/next' }]);
    await Promise.resolve();
    expect(pages).toHaveLength(2);

    handle.uninstall();
    expect(fakeWindow.history.pushState).toBe(originalPush);
  });

  test('is idempotent for the same data layer', () => {
    const first = install({ capturePageViews: false });
    const second = installGa4Bridge(sdk, { mode: 'replace', capturePageViews: false });
    handles.push(second);
    fakeWindow.dataLayer.push(['event', 'single_event']);

    expect(second).toBe(first);
    expect(second.mode).toBe('mirror');
    expect(tracks).toHaveLength(1);
  });
});
