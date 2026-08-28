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

  test('shutdown drains events enqueued while a send is in flight', async () => {
    let releaseFirstSend: () => void = () => {};
    const firstSendReleased = new Promise<void>(resolve => {
      releaseFirstSend = resolve;
    });
    globalThis.fetch = mock(async (_url: any, init: any) => {
      sentPayloads.push(JSON.parse(init.body));
      if (sentPayloads.length === 1) await firstSendReleased;
      return new Response('OK', { status: 200 });
    }) as any;

    const sdk = Alitycs.init({ apiKey: 'key', flushSize: 2, flushInterval: 3_600_000 });

    sdk.track('in_flight_a');
    sdk.track('in_flight_b'); // size trigger dispatches this pair and holds it in flight
    sdk.track('queued_c'); // enqueued while the first send is still in flight
    sdk.track('queued_d');

    expect(sdk.pending).toBe(2);

    const shutdown = sdk.shutdown();
    releaseFirstSend();
    await shutdown;

    const delivered = sentPayloads.flatMap(payload => payload.events.map(event => event.event));
    expect(delivered.sort()).toEqual(['in_flight_a', 'in_flight_b', 'queued_c', 'queued_d']);

    const eventIds = sentPayloads.flatMap(payload => payload.events.map(event => event.eventId));
    expect(new Set(eventIds).size).toBe(4);

    expect(sdk.pending).toBe(0);
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
    expect(ctx.sdkVersion).toBe('1.0.2');
    expect(ctx.sdkLanguage).toBe('typescript');
    expect(typeof ctx.timezone).toBe('string');

    await sdk.shutdown();
  });

  test('page URL overrides populate non-empty UTM context only', async () => {
    const sdk = Alitycs.init({ apiKey: 'key', flushSize: 100 });

    sdk.page('Campaign', {
      url: 'https://example.test/?utm_source=partner&utm_medium=&utm_term=analytics',
      referrer: '',
    });
    await sdk.flush();

    const context = sentPayloads[0].events[0].context;
    expect(context.url).toBe('https://example.test/?utm_source=partner&utm_medium=&utm_term=analytics');
    expect(context.referrer).toBe('');
    expect(context.utmSource).toBe('partner');
    expect(context.utmMedium).toBeUndefined();
    expect(context.utmCampaign).toBeUndefined();
    expect(context.utmContent).toBeUndefined();
    expect(context.utmTerm).toBe('analytics');

    await sdk.shutdown();
  });
});
