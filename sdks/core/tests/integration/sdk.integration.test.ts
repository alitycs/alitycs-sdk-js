import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Alitycs } from '../../src/index';
import type { BatchPayload } from '../../src/types';

describe('SDK Integration', () => {
  let originalFetch: typeof globalThis.fetch;
  let sentPayloads: BatchPayload[];
  let fetchHeaders: Record<string, string>[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sentPayloads = [];
    fetchHeaders = [];

    globalThis.fetch = mock(async (_url: any, init: any) => {
      fetchHeaders.push({ ...(init.headers as Record<string, string>) });
      sentPayloads.push(JSON.parse(init.body));
      return new Response('OK', { status: 200 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('complete user journey: init → identify → track → page → flush', async () => {
    const sdk = Alitycs.init({
      apiKey: 'integration-key',
      flushSize: 100,
    });

    sdk.identify('user-42', { plan: 'pro' });
    sdk.track('button_click', { color: 'red' });
    sdk.page('Dashboard', { section: 'home' });

    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    const events = sentPayloads[0].events;
    expect(events.length).toBe(3);

    // All events share the same session
    const sessionId = events[0].sessionId;
    expect(events.every(e => e.sessionId === sessionId)).toBe(true);

    // All events after identify have userId
    expect(events[0].userId).toBe('user-42'); // identify itself
    expect(events[1].userId).toBe('user-42');
    expect(events[2].userId).toBe('user-42');

    // Event types are correct
    expect(events[0].eventType).toBe('identify');
    expect(events[1].eventType).toBe('track');
    expect(events[2].eventType).toBe('page');

    await sdk.shutdown();
  });

  test('authorization header is sent correctly', async () => {
    const sdk = Alitycs.init({
      apiKey: 'my-secret-key',
      flushSize: 100,
    });

    sdk.track('test');
    await sdk.flush();

    expect(fetchHeaders[0]['Authorization']).toBe('Bearer my-secret-key');

    await sdk.shutdown();
  });

  test('properties serialization roundtrip', async () => {
    const sdk = Alitycs.init({ apiKey: 'key', flushSize: 100 });

    sdk.track('test', {
      string: 'hello',
      number: 42,
      bool: true,
      nil: null,
      undef: undefined,
      nested: { a: [1, 2, 3] },
    });

    await sdk.flush();

    const props = sentPayloads[0].events[0].properties;
    expect(props.string).toBe('hello');
    expect(props.number).toBe('42');
    expect(props.bool).toBe('true');
    expect(props.nil).toBe('null');
    expect(props.undef).toBeUndefined(); // skipped
    expect(props.nested).toBe('{"a":[1,2,3]}');

    await sdk.shutdown();
  });

  test('size-based auto-flush', async () => {
    const sdk = Alitycs.init({
      apiKey: 'key',
      flushSize: 3,
    });

    sdk.track('a');
    sdk.track('b');

    // Not yet flushed
    expect(sentPayloads.length).toBe(0);

    sdk.track('c'); // This should trigger auto-flush

    // Give async flush a moment
    await new Promise(r => setTimeout(r, 50));

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events.length).toBe(3);

    await sdk.shutdown();
  });

  test('shutdown flushes remaining events', async () => {
    const sdk = Alitycs.init({ apiKey: 'key', flushSize: 100 });

    sdk.track('pending_event');

    await sdk.shutdown();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events[0].event).toBe('pending_event');
  });

  test('transport failure does not throw', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Network failure');
    }) as any;

    const sdk = Alitycs.init({ apiKey: 'key', maxRetries: 0, flushSize: 100 });

    sdk.track('event');

    // Should not throw
    await sdk.flush();
    await sdk.shutdown();
  });

  test('high-volume tracking', async () => {
    const sdk = Alitycs.init({ apiKey: 'key', flushSize: 1000, maxQueueSize: 5000 });

    for (let i = 0; i < 500; i++) {
      sdk.track(`event_${i}`, { index: i });
    }

    expect(sdk.pending).toBe(500);

    await sdk.flush();

    const totalEvents = sentPayloads.reduce((sum, p) => sum + p.events.length, 0);
    expect(totalEvents).toBe(500);

    await sdk.shutdown();
  });

  test('context enrichment on every event', async () => {
    const sdk = Alitycs.init({ apiKey: 'key', flushSize: 100 });

    sdk.track('test');
    await sdk.flush();

    const ctx = sentPayloads[0].events[0].context;
    expect(ctx.sdkVersion).toBe('1.0.1');
    expect(ctx.sdkLanguage).toBe('typescript');
    expect(typeof ctx.timezone).toBe('string');

    await sdk.shutdown();
  });
});
