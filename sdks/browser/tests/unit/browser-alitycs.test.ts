import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  BrowserAlitycs,
  Alitycs,
  captureError,
  clearGlobalProperties,
  flush,
  getGlobalProperties,
  identify,
  init,
  page,
  removeGlobalProperties,
  reset,
  setGlobalProperties,
  shutdown,
  track,
} from '../../src/index';
import type { BatchPayload } from '@alitycs/core';

describe('BrowserAlitycs', () => {
  let originalFetch: typeof globalThis.fetch;
  let sentPayloads: BatchPayload[];
  let originalWindow: any;
  let originalDocument: any;
  let originalHistory: any;
  let windowListeners: Map<string, EventListener>;
  let documentListeners: Map<string, EventListener>;
  let sentRequestInits: RequestInit[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;
    originalHistory = (globalThis as any).history;
    sentPayloads = [];
    sentRequestInits = [];
    windowListeners = new Map();
    documentListeners = new Map();

    globalThis.fetch = mock(async (_url: any, init: any) => {
      sentPayloads.push(JSON.parse(init.body));
      sentRequestInits.push(init);
      return new Response('OK', { status: 200 });
    }) as any;

    (globalThis as any).window = {
      addEventListener: mock((event: string, handler: EventListener) => windowListeners.set(event, handler)),
      removeEventListener: mock((event: string) => windowListeners.delete(event)),
      location: { href: 'http://localhost/', hostname: 'localhost', pathname: '/' },
    };
    (globalThis as any).document = {
      referrer: '',
      title: 'Test',
      visibilityState: 'visible',
      addEventListener: mock((event: string, handler: EventListener) => documentListeners.set(event, handler)),
      removeEventListener: mock((event: string) => documentListeners.delete(event)),
    };
    (globalThis as any).history = {
      pushState: mock(() => {}),
      replaceState: mock(() => {}),
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).history = originalHistory;
  });

  test('init() requires apiKey', () => {
    expect(() => BrowserAlitycs.init({ apiKey: '' })).toThrow('apiKey is required');
  });

  test('init() returns a BrowserAlitycs instance', () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key' });
    expect(sdk).toBeInstanceOf(BrowserAlitycs);
    expect(sdk).toBeInstanceOf(Alitycs);
    sdk.shutdown();
  });

  test('autoCapture: true enables popstate listener', () => {
    const addEventListenerMock = (globalThis as any).window.addEventListener;
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', autoCapture: true });

    const calls = addEventListenerMock.mock.calls as unknown[][];
    const popstateCalls = calls.filter((c: unknown[]) => c[0] === 'popstate');
    expect(popstateCalls.length).toBe(1);

    sdk.shutdown();
  });

  test('autoCapture: false does not add popstate listener', () => {
    const addEventListenerMock = (globalThis as any).window.addEventListener;
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', autoCapture: false });

    const calls = addEventListenerMock.mock.calls as unknown[][];
    const popstateCalls = calls.filter((c: unknown[]) => c[0] === 'popstate');
    expect(popstateCalls.length).toBe(0);

    sdk.shutdown();
  });

  test('autoCapture emits one canonical page event for the initial document', async () => {
    (globalThis as any).document.referrer = 'https://search.example/results';
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', autoCapture: true, flushSize: 100 });

    await sdk.flush();

    const pageEvents = sentPayloads.flatMap(payload => payload.events).filter(event => event.eventType === 'page');
    expect(pageEvents).toHaveLength(1);
    expect(pageEvents[0]).toMatchObject({
      event: 'page_view',
      eventType: 'page',
      properties: {
        hostname: 'localhost',
        path: '/',
        referrer: 'https://search.example/results',
        title: 'Test',
        url: 'http://localhost/',
      },
    });

    await sdk.shutdown();
  });

  test('registers pagehide and visibilitychange handlers', () => {
    const addEventListenerMock = (globalThis as any).window.addEventListener;
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key' });

    const calls = addEventListenerMock.mock.calls as unknown[][];
    expect(calls.filter((c: unknown[]) => c[0] === 'pagehide')).toHaveLength(1);
    expect(((globalThis as any).document.addEventListener as ReturnType<typeof mock>).mock.calls).toContainEqual([
      'visibilitychange',
      expect.any(Function),
    ]);

    sdk.shutdown();
  });

  test('shutdown() removes page lifecycle handlers', async () => {
    const removeEventListenerMock = (globalThis as any).window.removeEventListener;
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key' });

    await sdk.shutdown();

    const calls = removeEventListenerMock.mock.calls as unknown[][];
    expect(calls.filter((c: unknown[]) => c[0] === 'pagehide')).toHaveLength(1);
    expect(((globalThis as any).document.removeEventListener as ReturnType<typeof mock>).mock.calls).toContainEqual([
      'visibilitychange',
      expect.any(Function),
    ]);
  });

  test('pagehide flushes queued events with bounded keepalive delivery', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', flushSize: 100 });
    sdk.page();

    windowListeners.get('pagehide')?.(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sentPayloads[0].events[0]).toMatchObject({ event: 'page_view', eventType: 'page' });
    expect(sentRequestInits[0].keepalive).toBe(true);
    expect((sentRequestInits[0].headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(new TextEncoder().encode(sentRequestInits[0].body as string).byteLength).toBeLessThanOrEqual(60_000);

    await sdk.shutdown();
  });

  test('hidden visibilitychange flushes once and a later empty pagehide is a no-op', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', flushSize: 100 });
    sdk.track('pending');
    (globalThis as any).document.visibilityState = 'hidden';

    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 0));
    windowListeners.get('pagehide')?.(new Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(sentPayloads).toHaveLength(1);

    await sdk.shutdown();
  });

  test('track() queues and flushes events', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('click', { color: 'red' });
    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events[0].event).toBe('click');
    expect(sentPayloads[0].events[0].properties.color).toBe('red');

    await sdk.shutdown();
  });

  test('module-level API delegates the complete browser capability surface', async () => {
    const sdk = init({ apiKey: 'test-key', flushSize: 100 });

    setGlobalProperties({ suite: 'module-api', removable: 'yes' });
    expect(getGlobalProperties()).toEqual({ suite: 'module-api', removable: 'yes' });
    removeGlobalProperties(['removable']);
    track('module_track', { n: 1 });
    captureError('module_error', { code: 'E_MODULE' });
    identify('module-user', { plan: 'pro' });
    page('ModulePage');
    reset();
    clearGlobalProperties();
    track('module_after_reset');
    await flush();

    expect(sdk).toBeInstanceOf(BrowserAlitycs);
    expect(sentPayloads.flatMap(payload => payload.events).map(event => event.event)).toEqual([
      'module_track',
      'module_error',
      'identify',
      'ModulePage',
      'module_after_reset',
    ]);

    await shutdown();
    expect(getGlobalProperties()).toEqual({});
  });

  test('trackRevenue() emits the shared revenue wire contract', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'publishable-key', flushSize: 100 });

    sdk.trackRevenue({
      version: 1,
      kind: 'transaction',
      factId: 'payment-123',
      amount: '71',
      currency: 'USD',
    });
    await sdk.flush();

    expect(sentPayloads[0].events[0]).toMatchObject({
      event: 'revenue_transaction',
      eventType: 'track',
      revenue: {
        version: 1,
        kind: 'transaction',
        factId: 'payment-123',
        amount: '71',
        currency: 'USD',
      },
    });

    await sdk.shutdown();
  });

  test('track() with dedupeKey drops duplicate', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('save', { id: '1' }, { dedupeKey: 'save:1' });
    sdk.track('save', { id: '1' }, { dedupeKey: 'save:1' });

    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events.length).toBe(1);
    expect(sentPayloads[0].events[0].dedupeKey).toBe('save:1');

    await sdk.shutdown();
  });

  test('track() without options — no regression', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('click', { color: 'red' });
    sdk.track('click', { color: 'red' });

    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events.length).toBe(2);

    await sdk.shutdown();
  });

  test('shutdown flushes remaining events', async () => {
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('final_event');
    await sdk.shutdown();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events[0].event).toBe('final_event');
  });
});
