import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BatchPayload } from '@alitycs/core';

describe('GA4 standalone browser entry', () => {
  let originalWindow: unknown;
  let originalDocument: unknown;
  let originalFetch: typeof globalThis.fetch;
  let sentPayloads: BatchPayload[];

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;
    originalFetch = globalThis.fetch;
    sentPayloads = [];

    const document = {
      currentScript: null,
      title: 'Checkout',
      referrer: '',
      visibilityState: 'visible',
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      querySelector: mock(() => null),
      querySelectorAll: mock(() => []),
    };
    (globalThis as any).document = document;
    (globalThis as any).window = {
      document,
      location: { href: 'https://shop.test/checkout', pathname: '/checkout' },
      history: { pushState: mock(() => {}), replaceState: mock(() => {}) },
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    };
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as BatchPayload);
      return new Response('OK', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    const api = (globalThis as any).window?.alitycs;
    if (typeof api?.shutdown === 'function') await api.shutdown();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    globalThis.fetch = originalFetch;
  });

  test('reads data attributes, exposes globals, and sends bridged events', async () => {
    const { initializeGa4FromScript } = await import('../../src/ga4-browser');
    const attributes: Record<string, string> = {
      'data-api-key': 'alitycs_test',
      'data-endpoint': 'https://events.test/events',
      'data-ga4-mode': 'replace',
      'data-ga4-data-layer': 'customLayer',
      'data-ga4-pageviews': 'false',
    };
    const script = {
      getAttribute: (name: string) => attributes[name] ?? null,
    } as HTMLScriptElement;

    const bridge = initializeGa4FromScript(script);
    const win = (globalThis as any).window;

    expect(bridge?.mode).toBe('replace');
    expect(typeof win.alitycs).toBe('function');
    expect(win.alitycs.loaded).toBe(true);
    expect(win.AlitycsSDK).toBeDefined();
    expect(win.AlitycsGA4).toBe(bridge);
    expect(Array.isArray(win.customLayer)).toBe(true);
    expect(typeof win.gtag).toBe('function');

    win.alitycs.setGlobalProperties({ suite: 'ga4-browser', removable: 'yes' });
    expect(win.alitycs.getGlobalProperties()).toEqual({ suite: 'ga4-browser', removable: 'yes' });
    win.alitycs.removeGlobalProperties(['removable']);
    win.alitycs.track('direct_track', { source: 'named' });
    win.alitycs('track', 'generic_track', { source: 'generic' });
    win.alitycs.identify('ga4-user', { plan: 'pro' });
    win.alitycs.page('CheckoutPage');
    win.gtag('event', 'purchase', { value: 42, currency: 'EUR' });
    win.alitycs.reset();
    win.alitycs.clearGlobalProperties();
    await win.alitycs.flush();

    const events = sentPayloads.flatMap(payload => payload.events);
    expect(events.map(event => event.event)).toEqual(
      expect.arrayContaining(['direct_track', 'generic_track', 'identify', 'CheckoutPage', 'purchase'])
    );
    expect(events.find(event => event.event === 'purchase')).toMatchObject({
      event: 'purchase',
      eventType: 'track',
      properties: {
        value: '42',
        currency: 'EUR',
        alitycs_integration: 'ga4',
        ga4_bridge_mode: 'replace',
      },
    });

    await win.alitycs.shutdown();
    expect(win.gtag).toBeUndefined();
    expect(win.alitycs).toBeUndefined();
    expect(win.AlitycsGA4).toBeUndefined();
  });

  test('rejects missing configuration and reuses an installed bridge', async () => {
    const { initializeGa4FromScript } = await import('../../src/ga4-browser');
    const missingKeyScript = {
      getAttribute: () => null,
    } as unknown as HTMLScriptElement;
    const originalError = console.error;
    const errorSpy = mock(() => {});
    console.error = errorSpy;

    try {
      expect(initializeGa4FromScript(missingKeyScript)).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }

    const script = {
      getAttribute: (name: string) => (name === 'data-api-key' ? 'alitycs_test' : null),
    } as HTMLScriptElement;
    const bridge = initializeGa4FromScript(script);
    expect(initializeGa4FromScript(script)).toBe(bridge);
  });
});
