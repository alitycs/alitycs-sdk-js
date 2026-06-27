import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { BrowserAlitycs, Alitycs } from '../../src/index';
import type { BatchPayload } from '@alitycs/core';

describe('BrowserAlitycs', () => {
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

    (globalThis as any).window = {
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      location: { href: 'http://localhost/', pathname: '/' },
    };
    (globalThis as any).document = {
      referrer: '',
      title: 'Test',
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
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

  test('registers beforeunload handler', () => {
    const addEventListenerMock = (globalThis as any).window.addEventListener;
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key' });

    const calls = addEventListenerMock.mock.calls as unknown[][];
    const beforeUnloadCalls = calls.filter((c: unknown[]) => c[0] === 'beforeunload');
    expect(beforeUnloadCalls.length).toBe(1);

    sdk.shutdown();
  });

  test('shutdown() removes beforeunload handler', async () => {
    const removeEventListenerMock = (globalThis as any).window.removeEventListener;
    const sdk = BrowserAlitycs.init({ apiKey: 'test-key' });

    await sdk.shutdown();

    const calls = removeEventListenerMock.mock.calls as unknown[][];
    const beforeUnloadCalls = calls.filter((c: unknown[]) => c[0] === 'beforeunload');
    expect(beforeUnloadCalls.length).toBe(1);
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
