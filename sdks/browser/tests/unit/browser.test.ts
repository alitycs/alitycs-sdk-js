import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BatchPayload } from '@alitycs/core';

describe('initializeFromSnippet', () => {
  let originalFetch: typeof globalThis.fetch;
  let sentPayloads: BatchPayload[];
  let originalWindow: any;
  let originalDocument: any;
  let originalHistory: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;
    originalHistory = (globalThis as any).history;
    sentPayloads = [];

    globalThis.fetch = mock(async (_url: any, init: any) => {
      sentPayloads.push(JSON.parse(init.body));
      return new Response('OK', { status: 200 });
    }) as any;

    // Set up minimal window/document/history globals for browser.ts
    (globalThis as any).window = {
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      location: { href: 'http://localhost/', pathname: '/' },
      alitycs: undefined,
      AlitycsSDK: undefined,
    };
    (globalThis as any).document = {
      referrer: '',
      title: '',
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    };
    (globalThis as any).history = {
      pushState: mock(() => {}),
      replaceState: mock(() => {}),
    };
  });

  afterEach(async () => {
    // Shutdown SDK if it was initialized
    const win = (globalThis as any).window;
    const sdk = win?.AlitycsSDK;
    if (sdk && typeof sdk.shutdown === 'function') {
      await sdk.shutdown();
    }

    globalThis.fetch = originalFetch;
    // Restore original window/document/history (undefined in Node/Bun)
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).history = originalHistory;
  });

  test('no stub on window => no-op', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');
    (globalThis as any).window.alitycs = undefined;

    expect(() => initializeFromSnippet()).not.toThrow();
    expect((globalThis as any).window.AlitycsSDK).toBeUndefined();
  });

  test('valid config => initializes SDK', async () => {
    const { initializeFromSnippet, BrowserAlitycs } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [],
      loaded: false,
    };

    initializeFromSnippet();

    expect((globalThis as any).window.alitycs.loaded).toBe(true);
    expect((globalThis as any).window.AlitycsSDK).toBeInstanceOf(BrowserAlitycs);
  });

  test('no apiKey => logs error', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: {},
      _queue: [],
      loaded: false,
    };

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    initializeFromSnippet();

    console.error = originalError;

    expect(errorSpy).toHaveBeenCalled();
    const callArgs = errorSpy.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('[Alitycs]');
    expect(callArgs[1]).toContain('API key not found');
    expect((globalThis as any).window.AlitycsSDK).toBeUndefined();
  });

  test('loaded: true => skips initialization', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [],
      loaded: true,
    };

    initializeFromSnippet();

    expect((globalThis as any).window.AlitycsSDK).toBeUndefined();
  });

  test('queued calls are replayed', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [
        { method: 'track', args: ['button_click', { color: 'red' }], timestamp: Date.now() },
        { method: 'captureError', args: ['checkout_failed', { code: 'PAYMENT' }], timestamp: Date.now() },
        { method: 'identify', args: ['user-1', { plan: 'pro' }], timestamp: Date.now() },
        { method: 'page', args: ['Home'], timestamp: Date.now() },
      ],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    expect(sdk).toBeDefined();

    await sdk.flush();

    expect(sentPayloads.length).toBeGreaterThanOrEqual(1);

    const allEvents = sentPayloads.flatMap((p: BatchPayload) => p.events);
    expect(allEvents.length).toBe(4);
    expect(allEvents[0].event).toBe('button_click');
    expect(allEvents[0].eventType).toBe('track');
    expect(allEvents[1].event).toBe('checkout_failed');
    expect(allEvents[1].eventType).toBe('error');
    expect(allEvents[2].event).toBe('identify');
    expect(allEvents[2].eventType).toBe('identify');
    expect(allEvents[3].event).toBe('Home');
    expect(allEvents[3].eventType).toBe('page');
  });

  test('queued setGlobalProperties calls are replayed', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [
        { method: 'setGlobalProperties', args: [{ appVersion: '1.0' }], timestamp: Date.now() },
        { method: 'track', args: ['click'], timestamp: Date.now() },
      ],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    expect(sdk).toBeDefined();

    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: BatchPayload) => p.events);
    const trackEvent = allEvents.find((e: any) => e.event === 'click');
    expect(trackEvent).toBeDefined();
    expect(trackEvent!.properties.appVersion).toBe('1.0');
  });

  test('autoTrack alone does not enable autoCapture listeners', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');
    const addEventListenerMock = (globalThis as any).window.addEventListener;

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key', autoTrack: true },
      _queue: [],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    expect(sdk).toBeDefined();
    // autoCapture adds a 'popstate' listener; autoTrack alone should not
    const calls = addEventListenerMock.mock.calls as unknown[][];
    const popstateCalls = calls.filter((c: unknown[]) => c[0] === 'popstate');
    expect(popstateCalls.length).toBe(0);
  });

  test('autoCapture: true enables popstate listener', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');
    const addEventListenerMock = (globalThis as any).window.addEventListener;

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key', autoCapture: true },
      _queue: [],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    expect(sdk).toBeDefined();
    const calls = addEventListenerMock.mock.calls as unknown[][];
    const popstateCalls = calls.filter((c: unknown[]) => c[0] === 'popstate');
    expect(popstateCalls.length).toBe(1);
  });

  test('skips bare page() when autoCapture is true', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key', autoCapture: true },
      _queue: [
        { method: 'track', args: ['click', {}], timestamp: Date.now() },
        { method: 'page', args: [], timestamp: Date.now() },
      ],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: any) => p.events);
    const pageEvents = allEvents.filter((e: any) => e.eventType === 'page');
    // Bare page() (args=[]) is skipped; only autoCapture's canonical initial page event remains.
    expect(pageEvents).toHaveLength(1);
    expect(pageEvents[0].event).toBe('page_view');
  });

  test('preserves the snippet document before a navigation during SDK load', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');
    const capturedAt = 1_700_000_000_000;
    const originalNow = Date.now;
    (globalThis as any).window.location = {
      href: 'http://localhost/pricing',
      hostname: 'localhost',
      pathname: '/pricing',
      search: '',
    };
    (globalThis as any).document.title = 'Pricing';
    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key', autoCapture: true },
      _queue: [
        {
          method: 'page',
          args: [
            undefined,
            {
              hostname: 'localhost',
              path: '/',
              referrer: 'https://google.com/',
              title: 'Landing',
              url: 'http://localhost/?utm_source=google',
            },
          ],
          timestamp: capturedAt,
        },
      ],
      loaded: false,
    };

    Date.now = () => capturedAt;
    try {
      initializeFromSnippet();
    } finally {
      Date.now = originalNow;
    }
    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const pageEvents = sentPayloads
      .flatMap((payload: BatchPayload) => payload.events)
      .filter(event => event.eventType === 'page');
    expect(pageEvents).toHaveLength(2);
    expect(pageEvents.map(event => event.context.url)).toEqual([
      'http://localhost/?utm_source=google',
      'http://localhost/pricing',
    ]);
    expect(pageEvents[0].context.referrer).toBe('https://google.com/');
    expect(pageEvents[0].context.utmSource).toBe('google');
    expect(pageEvents[0].properties.title).toBe('Landing');
    expect(pageEvents.map(event => event.timestamp)).toEqual([capturedAt, capturedAt + 1]);
  });

  test('replays custom page("Name") when autoCapture is true', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key', autoCapture: true },
      _queue: [{ method: 'page', args: ['ProductPage', { sku: '123' }], timestamp: Date.now() }],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: any) => p.events);
    const pageEvents = allEvents.filter((e: any) => e.eventType === 'page');
    // Custom page('ProductPage') should be replayed alongside autoCapture's $pageview
    const customPage = pageEvents.find((e: any) => e.event === 'ProductPage');
    expect(customPage).toBeDefined();
    expect(customPage!.properties.sku).toBe('123');
  });

  test('replays page calls when autoCapture is false', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key', autoCapture: false },
      _queue: [{ method: 'page', args: ['Home'], timestamp: Date.now() }],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: any) => p.events);
    const pageEvents = allEvents.filter((e: any) => e.eventType === 'page');
    expect(pageEvents.length).toBe(1);
    expect(pageEvents[0].event).toBe('Home');
  });

  test('window.alitycs.track forwards options (dedupeKey)', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [],
      loaded: false,
    };

    initializeFromSnippet();

    const api = (globalThis as any).window.alitycs;
    api.track('search', { q: 'a' }, { dedupeKey: 'search:a' });
    api.track('search', { q: 'a' }, { dedupeKey: 'search:a' });

    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: BatchPayload) => p.events);
    // Second call should be deduped
    const searchEvents = allEvents.filter((e: any) => e.event === 'search');
    expect(searchEvents.length).toBe(1);
    expect(searchEvents[0].dedupeKey).toBe('search:a');
  });

  test('generic dispatch forwards options (dedupeKey)', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [],
      loaded: false,
    };

    initializeFromSnippet();

    const api = (globalThis as any).window.alitycs;
    api('track', 'search', { q: 'b' }, { dedupeKey: 'search:b' });
    api('track', 'search', { q: 'b' }, { dedupeKey: 'search:b' });

    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: BatchPayload) => p.events);
    const searchEvents = allEvents.filter((e: any) => e.event === 'search');
    expect(searchEvents.length).toBe(1);
  });

  test('queue replay preserves options through queue→SDK path', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [
        { method: 'track', args: ['click', { btn: '1' }, { dedupeKey: 'click:1' }], timestamp: Date.now() },
        { method: 'track', args: ['click', { btn: '1' }, { dedupeKey: 'click:1' }], timestamp: Date.now() },
      ],
      loaded: false,
    };

    initializeFromSnippet();

    const sdk = (globalThis as any).window.AlitycsSDK;
    await sdk.flush();

    const allEvents = sentPayloads.flatMap((p: BatchPayload) => p.events);
    const clickEvents = allEvents.filter((e: any) => e.event === 'click');
    expect(clickEvents.length).toBe(1);
    expect(clickEvents[0].dedupeKey).toBe('click:1');
  });

  test('after init, window.alitycs methods work', async () => {
    const { initializeFromSnippet } = await import('../../src/browser');

    (globalThis as any).window.alitycs = {
      _config: { apiKey: 'test-key' },
      _queue: [],
      loaded: false,
    };

    initializeFromSnippet();

    const api = (globalThis as any).window.alitycs;
    expect(() => {
      api.track('test_event');
    }).not.toThrow();

    expect(() => {
      api.identify('user-2', { name: 'test' });
    }).not.toThrow();

    expect(() => {
      api.reset();
    }).not.toThrow();

    expect(() => {
      api.page('TestPage');
    }).not.toThrow();

    api.captureError('named_error', { code: 'E_NAMED' });
    api.setGlobalProperties({ suite: 'snippet-api', removable: 'yes' });
    expect(api.getGlobalProperties()).toEqual({ suite: 'snippet-api', removable: 'yes' });
    api.removeGlobalProperties(['removable']);
    api.clearGlobalProperties();

    api('captureError', 'generic_error', { code: 'E_GENERIC' });
    api('identify', 'generic-user', { plan: 'pro' });
    api('page', 'GenericPage');
    api('setGlobalProperties', { suite: 'generic' });
    api('removeGlobalProperties', ['suite']);
    api('clearGlobalProperties');
    api('reset');

    await api.flush();
    const events = sentPayloads.flatMap((payload: BatchPayload) => payload.events);
    expect(events.map(event => event.event)).toEqual(
      expect.arrayContaining(['named_error', 'generic_error', 'identify', 'GenericPage'])
    );

    await api.shutdown();
  });
});
