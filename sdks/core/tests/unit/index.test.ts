import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Alitycs } from '../../src/index';
import type { BatchPayload } from '../../src/types';

describe('Alitycs', () => {
  let originalFetch: typeof globalThis.fetch;
  let sentPayloads: BatchPayload[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sentPayloads = [];

    globalThis.fetch = mock(async (_url: any, init: any) => {
      sentPayloads.push(JSON.parse(init.body));
      return new Response('OK', { status: 200 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('init() requires apiKey', () => {
    expect(() => Alitycs.init({ apiKey: '' })).toThrow('apiKey is required');
    expect(() => Alitycs.init({ apiKey: '  ' })).toThrow('apiKey is required');
  });

  test('init() returns an Alitycs instance', () => {
    const sdk = Alitycs.init({ apiKey: 'test-key' });
    expect(sdk).toBeInstanceOf(Alitycs);
    sdk.shutdown();
  });

  test('init() is not singleton — returns different instances', () => {
    const a = Alitycs.init({ apiKey: 'key-a' });
    const b = Alitycs.init({ apiKey: 'key-b' });
    expect(a).not.toBe(b);
    a.shutdown();
    b.shutdown();
  });

  test('track() is synchronous and queues event', () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('button_click', { color: 'red' });
    sdk.track('form_submit', { form: 'signup' });

    expect(sdk.pending).toBe(2);
    sdk.shutdown();
  });

  test('track() ignores empty event names', () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('');

    expect(sdk.pending).toBe(0);
    sdk.shutdown();
  });

  test('identify() sets userId on events', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.identify('user-42', { plan: 'pro' });
    sdk.track('action');

    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    const events = sentPayloads[0].events;
    expect(events.length).toBe(2);

    // Identify event
    expect(events[0].event).toBe('identify');
    expect(events[0].eventType).toBe('identify');
    expect(events[0].properties.userId).toBe('user-42');
    expect(events[0].properties.plan).toBe('pro');

    // Track event after identify
    expect(events[1].userId).toBe('user-42');

    await sdk.shutdown();
  });

  test('page() creates a page event', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.page('Dashboard', { section: 'home' });

    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    const event = sentPayloads[0].events[0];
    expect(event.event).toBe('Dashboard');
    expect(event.eventType).toBe('page');
    expect(event.properties.section).toBe('home');

    await sdk.shutdown();
  });

  test('flush() sends all pending events', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('a');
    sdk.track('b');
    sdk.track('c');

    await sdk.flush();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events.length).toBe(3);
    expect(sdk.pending).toBe(0);

    await sdk.shutdown();
  });

  test('shutdown() flushes remaining events', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('final_event');

    await sdk.shutdown();

    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events[0].event).toBe('final_event');
  });

  test('events have correct structure', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('test_event', { count: 42, nested: { a: 1 } });

    await sdk.flush();

    const event = sentPayloads[0].events[0];

    expect(event.eventId).toMatch(/^evt_/);
    expect(event.event).toBe('test_event');
    expect(event.eventType).toBe('track');
    expect(event.anonymousId).toMatch(/^anon_/);
    expect(event.sessionId).toMatch(/^sess_/);
    expect(typeof event.timestamp).toBe('number');

    // Properties are serialized to strings
    expect(event.properties.count).toBe('42');
    expect(event.properties.nested).toBe('{"a":1}');

    // Context
    expect(event.context.sdkVersion).toBe('1.0.0');
    expect(event.context.sdkLanguage).toBe('typescript');

    await sdk.shutdown();
  });

  test('batch payload has correct structure', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('event1');
    await sdk.flush();

    const payload = sentPayloads[0];
    expect(payload.batchId).toMatch(/^batch_/);
    expect(typeof payload.sentAt).toBe('number');
    expect(Array.isArray(payload.events)).toBe(true);

    await sdk.shutdown();
  });

  describe('batching: false', () => {
    test('sends immediately on track()', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', batching: false });

      sdk.track('instant_event', { key: 'val' });

      // Wait a tick for the fire-and-forget send to complete
      await new Promise(r => setTimeout(r, 10));

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events.length).toBe(1);
      expect(sentPayloads[0].events[0].event).toBe('instant_event');

      await sdk.shutdown();
    });

    test('each event sent as separate BatchPayload', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', batching: false });

      sdk.track('event_a');
      sdk.track('event_b');
      sdk.track('event_c');

      await sdk.flush();

      expect(sentPayloads.length).toBe(3);
      expect(sentPayloads[0].events.length).toBe(1);
      expect(sentPayloads[1].events.length).toBe(1);
      expect(sentPayloads[2].events.length).toBe(1);
      expect(sentPayloads[0].events[0].event).toBe('event_a');
      expect(sentPayloads[1].events[0].event).toBe('event_b');
      expect(sentPayloads[2].events[0].event).toBe('event_c');

      await sdk.shutdown();
    });

    test('flush() waits for in-flight sends', async () => {
      let resolveDelayed!: () => void;
      const delayed = new Promise<void>(r => {
        resolveDelayed = r;
      });

      globalThis.fetch = mock(async (_url: any, init: any) => {
        sentPayloads.push(JSON.parse(init.body));
        await delayed;
        return new Response('OK', { status: 200 });
      }) as any;

      const sdk = Alitycs.init({ apiKey: 'test-key', batching: false });
      sdk.track('slow_event');

      // pending should reflect in-flight
      expect(sdk.pending).toBe(1);

      // Resolve the delayed fetch
      resolveDelayed();
      await sdk.flush();

      expect(sentPayloads.length).toBe(1);
      expect(sdk.pending).toBe(0);

      await sdk.shutdown();
    });

    test('shutdown() waits for in-flight sends', async () => {
      let resolveDelayed!: () => void;
      const delayed = new Promise<void>(r => {
        resolveDelayed = r;
      });

      globalThis.fetch = mock(async (_url: any, init: any) => {
        sentPayloads.push(JSON.parse(init.body));
        await delayed;
        return new Response('OK', { status: 200 });
      }) as any;

      const sdk = Alitycs.init({ apiKey: 'test-key', batching: false });
      sdk.track('shutdown_event');

      expect(sdk.pending).toBe(1);

      resolveDelayed();
      await sdk.shutdown();

      expect(sentPayloads.length).toBe(1);
      expect(sdk.pending).toBe(0);
    });

    test('batch payloads have correct structure', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', batching: false });

      sdk.track('struct_event');
      await sdk.flush();

      const payload = sentPayloads[0];
      expect(payload.batchId).toMatch(/^batch_/);
      expect(typeof payload.sentAt).toBe('number');
      expect(Array.isArray(payload.events)).toBe(true);
      expect(payload.events.length).toBe(1);

      await sdk.shutdown();
    });
  });

  test('default batching behavior unchanged', async () => {
    const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

    sdk.track('a');
    sdk.track('b');

    // Events are queued, not sent immediately
    expect(sentPayloads.length).toBe(0);
    expect(sdk.pending).toBe(2);

    await sdk.flush();

    // Sent as a single batch
    expect(sentPayloads.length).toBe(1);
    expect(sentPayloads[0].events.length).toBe(2);

    await sdk.shutdown();
  });

  describe('Global Properties', () => {
    test('setGlobalProperties merges into track events', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ appVersion: '1.0', env: 'prod' });
      sdk.track('click');
      await sdk.flush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.appVersion).toBe('1.0');
      expect(event.properties.env).toBe('prod');
      await sdk.shutdown();
    });

    test('event properties override global properties', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ color: 'blue' });
      sdk.track('click', { color: 'red' });
      await sdk.flush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.color).toBe('red');
      await sdk.shutdown();
    });

    test('accumulates across multiple set calls', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ a: '1' });
      sdk.setGlobalProperties({ b: '2' });
      sdk.track('click');
      await sdk.flush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.a).toBe('1');
      expect(event.properties.b).toBe('2');
      await sdk.shutdown();
    });

    test('getGlobalProperties returns copy (not reference)', () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ key: 'val' });
      const props = sdk.getGlobalProperties();
      props.key = 'changed';
      expect(sdk.getGlobalProperties().key).toBe('val');
      sdk.shutdown();
    });

    test('removeGlobalProperties removes specific keys', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ a: '1', b: '2', c: '3' });
      sdk.removeGlobalProperties(['a', 'c']);
      sdk.track('click');
      await sdk.flush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.b).toBe('2');
      expect(event.properties.a).toBeUndefined();
      expect(event.properties.c).toBeUndefined();
      await sdk.shutdown();
    });

    test('clearGlobalProperties clears all', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ a: '1', b: '2' });
      sdk.clearGlobalProperties();
      sdk.track('click');
      await sdk.flush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.a).toBeUndefined();
      expect(event.properties.b).toBeUndefined();
      await sdk.shutdown();
    });

    test('values are serialized to strings', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ count: 42, active: true });
      sdk.track('click');
      await sdk.flush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.count).toBe('42');
      expect(event.properties.active).toBe('true');
      await sdk.shutdown();
    });

    test('apply to all event types (track, identify, page)', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });
      sdk.setGlobalProperties({ appVersion: '2.0' });
      sdk.track('click');
      sdk.identify('user-1');
      sdk.page('Home');
      await sdk.flush();
      const events = sentPayloads[0].events;
      expect(events[0].properties.appVersion).toBe('2.0');
      expect(events[1].properties.appVersion).toBe('2.0');
      expect(events[2].properties.appVersion).toBe('2.0');
      await sdk.shutdown();
    });
  });

  describe('Module-level convenience API - globals', () => {
    test('module-level setGlobalProperties + track attaches globals', async () => {
      const {
        init: moduleInit,
        setGlobalProperties: moduleSetGlobal,
        track: moduleTrack,
        flush: moduleFlush,
        shutdown: moduleShutdown,
      } = await import('../../src/index');
      moduleInit({ apiKey: 'test-key', flushSize: 100 });
      moduleSetGlobal({ version: '1.0' });
      moduleTrack('click');
      await moduleFlush();
      const event = sentPayloads[0].events[0];
      expect(event.properties.version).toBe('1.0');
      await moduleShutdown();
    });

    test('module-level getGlobalProperties returns {} before init', async () => {
      const { getGlobalProperties: moduleGetGlobal } = await import('../../src/index');
      const result = moduleGetGlobal();
      expect(typeof result).toBe('object');
    });
  });

  describe('batching: false - globals', () => {
    test('global properties work with batching: false', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', batching: false });
      sdk.setGlobalProperties({ env: 'staging' });
      sdk.track('click');
      await new Promise(r => setTimeout(r, 10));
      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events[0].properties.env).toBe('staging');
      await sdk.shutdown();
    });
  });

  describe('Event Deduplication', () => {
    test('track() with dedupeKey drops duplicate within window', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

      sdk.track('search', { query: 'rome' }, { dedupeKey: 'search:rome' });
      sdk.track('search', { query: 'rome' }, { dedupeKey: 'search:rome' });

      await sdk.flush();

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events.length).toBe(1);

      await sdk.shutdown();
    });

    test('track() with dedupeKey: event payload contains dedupeKey field', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

      sdk.track('save', { id: '1' }, { dedupeKey: 'save:1' });

      await sdk.flush();

      const event = sentPayloads[0].events[0];
      expect(event.dedupeKey).toBe('save:1');

      await sdk.shutdown();
    });

    test('identify() accepts EventOptions', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

      sdk.identify('user-1', { plan: 'pro' }, { dedupeKey: 'id:user-1' });
      sdk.identify('user-1', { plan: 'pro' }, { dedupeKey: 'id:user-1' });

      await sdk.flush();

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events.length).toBe(1);

      await sdk.shutdown();
    });

    test('page() accepts EventOptions', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

      sdk.page('Home', {}, { dedupeKey: 'page:home' });
      sdk.page('Home', {}, { dedupeKey: 'page:home' });

      await sdk.flush();

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events.length).toBe(1);

      await sdk.shutdown();
    });

    test('track() without options — no regression', async () => {
      const sdk = Alitycs.init({ apiKey: 'test-key', flushSize: 100 });

      sdk.track('click', { color: 'red' });
      sdk.track('click', { color: 'red' });

      await sdk.flush();

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events.length).toBe(2);

      await sdk.shutdown();
    });

    test('module-level track() passes options through', async () => {
      const {
        init: moduleInit,
        track: moduleTrack,
        flush: moduleFlush,
        shutdown: moduleShutdown,
      } = await import('../../src/index');
      moduleInit({ apiKey: 'test-key', flushSize: 100 });

      moduleTrack('search', { q: 'a' }, { dedupeKey: 'search:a' });
      moduleTrack('search', { q: 'a' }, { dedupeKey: 'search:a' });

      await moduleFlush();

      expect(sentPayloads.length).toBe(1);
      expect(sentPayloads[0].events.length).toBe(1);

      await moduleShutdown();
    });
  });

  test('multiple instances are independent', async () => {
    const payloadsA: BatchPayload[] = [];
    const payloadsB: BatchPayload[] = [];

    globalThis.fetch = mock(async (_url: any, init: any) => {
      const payload = JSON.parse(init.body);
      // Route based on event names
      if (payload.events[0]?.event.startsWith('a_')) payloadsA.push(payload);
      else payloadsB.push(payload);
      return new Response('OK', { status: 200 });
    }) as any;

    const sdkA = Alitycs.init({ apiKey: 'key-a', flushSize: 100 });
    const sdkB = Alitycs.init({ apiKey: 'key-b', flushSize: 100 });

    sdkA.track('a_event');
    sdkB.track('b_event');

    await sdkA.flush();
    await sdkB.flush();

    expect(payloadsA.length).toBe(1);
    expect(payloadsB.length).toBe(1);
    expect(payloadsA[0].events[0].event).toBe('a_event');
    expect(payloadsB[0].events[0].event).toBe('b_event');

    await sdkA.shutdown();
    await sdkB.shutdown();
  });
});
