import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { BatchManager } from '../../src/batch-manager';
import type { AnalyticsEvent, ResolvedConfig, BatchPayload } from '../../src/types';
import type { TransportResult } from '../../src/transport';
import { createLogger } from '../../src/logger';

let nextEventId = 0;

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiKey: 'test-key',
    endpoint: 'https://api.test.com/events',
    flushInterval: 60_000, // large so timer doesn't fire during tests
    flushSize: 5,
    maxQueueSize: 100,
    maxRetries: 0,
    debug: false,
    sessionTimeout: 30 * 60 * 1000,
    batching: true,
    ...overrides,
  };
}

function makeEvent(name = 'test_event'): AnalyticsEvent {
  return {
    eventId: `evt_${nextEventId++}`,
    event: name,
    eventType: 'track',
    anonymousId: 'anon_123',
    sessionId: 'sess_123',
    timestamp: Date.now(),
    properties: {},
    context: { sdkVersion: '1.0.2', sdkLanguage: 'typescript' },
  };
}

const OK: TransportResult = { ok: true, transient: false };

function makeMockTransport(result: TransportResult | ((payload: BatchPayload) => TransportResult) = OK) {
  const sent: BatchPayload[] = [];
  const options: unknown[] = [];
  return {
    send: mock(async (payload: BatchPayload, sendOptions?: unknown): Promise<TransportResult> => {
      sent.push(payload);
      options.push(sendOptions);
      return typeof result === 'function' ? result(payload) : result;
    }),
    sent,
    options,
  };
}

describe('BatchManager', () => {
  let bm: BatchManager;

  afterEach(() => {
    bm?.stop();
  });

  test('add() queues events', () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    bm.add(makeEvent());
    bm.add(makeEvent());

    expect(bm.pending).toBe(2);
  });

  test('flush() sends all queued events', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    bm.add(makeEvent('a'));
    bm.add(makeEvent('b'));

    await bm.flush();

    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0].events.length).toBe(2);
    expect(transport.sent[0].events[0].event).toBe('a');
    expect(transport.sent[0].events[1].event).toBe('b');
    expect(bm.pending).toBe(0);
  });

  test('flush() is no-op when queue is empty', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    await bm.flush();

    expect(transport.sent.length).toBe(0);
  });

  test('auto-flushes when flushSize is reached', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig({ flushSize: 3 }), transport as any, createLogger(false));

    bm.add(makeEvent());
    bm.add(makeEvent());

    // Not yet flushed
    expect(transport.sent.length).toBe(0);

    bm.add(makeEvent());

    // Wait for the async flush triggered by flushSize
    await new Promise(r => setTimeout(r, 10));

    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0].events.length).toBe(3);
  });

  test('drops events when queue is full', () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig({ maxQueueSize: 2, flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('a'));
    bm.add(makeEvent('b'));
    bm.add(makeEvent('c')); // Should be dropped

    expect(bm.pending).toBe(2);
  });

  test('batch payload has batchId and sentAt', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    bm.add(makeEvent());
    await bm.flush();

    const payload = transport.sent[0];
    expect(payload.batchId).toMatch(/^batch_/);
    expect(typeof payload.sentAt).toBe('number');
    expect(payload.sentAt).toBeGreaterThan(0);
  });

  test('timer flushes periodically', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig({ flushInterval: 50 }), transport as any, createLogger(false));
    bm.start();

    bm.add(makeEvent());

    // Wait for timer to fire
    await new Promise(r => setTimeout(r, 100));

    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
  });

  test('keepalive flush bounds the payload and forwards transport options', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    for (let index = 0; index < 5; index++) {
      bm.add({ ...makeEvent(`page-${index}`), properties: { payload: 'x'.repeat(120) } });
    }

    await bm.flush({ keepalive: true, maxPayloadBytes: 700, maxRetries: 0 });

    expect(transport.sent).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(transport.sent[0])).byteLength).toBeLessThanOrEqual(700);
    expect(transport.options[0]).toEqual({ keepalive: true, maxRetries: 0 });
    expect(transport.sent[0].events.length).toBeGreaterThan(0);
    expect(bm.pending).toBeGreaterThan(0);
  });

  test('keepalive flush replays in-flight events before newly queued events', async () => {
    let finishNormalFlush: (() => void) | undefined;
    const normalFlushPending = new Promise<void>(resolve => {
      finishNormalFlush = resolve;
    });
    const sent: BatchPayload[] = [];
    const options: unknown[] = [];
    const transport = {
      send: mock(async (payload: BatchPayload, sendOptions?: unknown) => {
        sent.push(payload);
        options.push(sendOptions);
        if (sent.length === 1) await normalFlushPending;
      }),
    };
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('normal'));
    const normalFlush = bm.flush();
    await Promise.resolve();
    bm.add(makeEvent('page-exit'));

    await bm.flush({ keepalive: true, maxPayloadBytes: 60_000, maxRetries: 0 });

    expect(sent).toHaveLength(2);
    expect(sent[1].events.map(event => event.event)).toEqual(['normal', 'page-exit']);
    expect(options[1]).toEqual({ keepalive: true, maxRetries: 0 });
    expect(bm.pending).toBe(0);

    finishNormalFlush?.();
    await normalFlush;
  });

  test('bounded keepalive replay prioritizes the unresolved batch over newer queued events', async () => {
    let finishNormalFlush: (() => void) | undefined;
    const normalFlushPending = new Promise<void>(resolve => {
      finishNormalFlush = resolve;
    });
    const sent: BatchPayload[] = [];
    const transport = {
      send: mock(async (payload: BatchPayload) => {
        sent.push(payload);
        if (sent.length === 1) await normalFlushPending;
      }),
    };
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add({ ...makeEvent('in-flight'), properties: { payload: 'x'.repeat(400) } });
    const normalFlush = bm.flush();
    await Promise.resolve();
    bm.add({ ...makeEvent('newer-queued'), properties: { payload: 'y'.repeat(400) } });

    await bm.flush({ keepalive: true, maxPayloadBytes: 900, maxRetries: 0 });

    expect(sent).toHaveLength(2);
    expect(sent[1].events.map(event => event.event)).toEqual(['in-flight']);
    expect(new TextEncoder().encode(JSON.stringify(sent[1])).byteLength).toBeLessThanOrEqual(900);
    expect(bm.pending).toBe(1);

    finishNormalFlush?.();
    await normalFlush;
    await bm.drain();
    expect(sent[2].events.map(event => event.event)).toEqual(['newer-queued']);
  });

  test('flush() awaits an in-flight send and then drains queued events', async () => {
    let finishFirstSend: (() => void) | undefined;
    const firstSendPending = new Promise<void>(resolve => {
      finishFirstSend = resolve;
    });
    const sent: BatchPayload[] = [];
    const transport = {
      send: mock(async (payload: BatchPayload) => {
        sent.push(payload);
        if (sent.length === 1) await firstSendPending;
      }),
    };
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    bm.add(makeEvent('a'));
    const inFlight = bm.flush();
    await Promise.resolve();
    bm.add(makeEvent('b'));

    const followUp = bm.flush();
    expect(sent).toHaveLength(1);

    finishFirstSend?.();
    await Promise.all([inFlight, followUp]);

    expect(sent).toHaveLength(2);
    expect(sent[1].events.map(event => event.event)).toEqual(['b']);
    expect(bm.pending).toBe(0);
  });

  test('concurrent flushes during an in-flight send coalesce into one follow-up batch', async () => {
    let finishFirstSend: (() => void) | undefined;
    const firstSendPending = new Promise<void>(resolve => {
      finishFirstSend = resolve;
    });
    const sent: BatchPayload[] = [];
    const transport = {
      send: mock(async (payload: BatchPayload) => {
        sent.push(payload);
        if (sent.length === 1) await firstSendPending;
      }),
    };
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('a'));
    const inFlight = bm.flush();
    await Promise.resolve();
    bm.add(makeEvent('b'));
    bm.add(makeEvent('c'));

    const waiterOne = bm.flush();
    const waiterTwo = bm.flush();
    const waiterThree = bm.flush();

    finishFirstSend?.();
    await Promise.all([inFlight, waiterOne, waiterTwo, waiterThree]);

    expect(sent).toHaveLength(2);
    expect(sent[1].events.map(event => event.event)).toEqual(['b', 'c']);
    expect(bm.pending).toBe(0);
  });

  test('drain() waits for an in-flight send before emptying the queue', async () => {
    let finishFirstSend: (() => void) | undefined;
    const firstSendPending = new Promise<void>(resolve => {
      finishFirstSend = resolve;
    });
    const sent: BatchPayload[] = [];
    const transport = {
      send: mock(async (payload: BatchPayload) => {
        sent.push(payload);
        if (sent.length === 1) await firstSendPending;
      }),
    };
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    bm.add(makeEvent('a'));
    const inFlight = bm.flush();
    await Promise.resolve();
    bm.add(makeEvent('b'));

    const drained = bm.drain();
    expect(bm.pending).toBe(1);

    finishFirstSend?.();
    await Promise.all([inFlight, drained]);

    expect(sent).toHaveLength(2);
    expect(sent[1].events.map(event => event.event)).toEqual(['b']);
    expect(bm.pending).toBe(0);
  });

  test('drain() sends payload-bounded remainders until the queue is empty', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    for (let index = 0; index < 5; index++) {
      bm.add({ ...makeEvent(`page-${index}`), properties: { payload: 'x'.repeat(120) } });
    }

    await bm.drain({ maxPayloadBytes: 700 });

    expect(bm.pending).toBe(0);
    expect(transport.sent.length).toBeGreaterThan(1);
    expect(transport.sent.flatMap(payload => payload.events.map(event => event.event))).toHaveLength(5);
    for (const payload of transport.sent) {
      expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(700);
    }
  });

  test('drain clears its flush slot when every queued event exceeds the payload bound', async () => {
    const transport = makeMockTransport();
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));
    bm.add({ ...makeEvent('oversized'), properties: { payload: 'x'.repeat(1_000) } });

    await bm.drain({ maxPayloadBytes: 100 });

    expect(bm.pending).toBe(0);
    expect(transport.sent).toHaveLength(0);

    bm.add(makeEvent('after-oversized'));
    await bm.flush();
    expect(transport.sent[0].events.map(event => event.event)).toEqual(['after-oversized']);
  });

  test('keepalive flush replays an unresolved normal batch during page exit', async () => {
    let finishNormalFlush: (() => void) | undefined;
    const normalFlushPending = new Promise<void>(resolve => {
      finishNormalFlush = resolve;
    });
    const sent: BatchPayload[] = [];
    const options: unknown[] = [];
    const transport = {
      send: mock(async (payload: BatchPayload, sendOptions?: unknown) => {
        sent.push(payload);
        options.push(sendOptions);
        if (sent.length === 1) await normalFlushPending;
      }),
    };
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('in-flight'));
    const normalFlush = bm.flush();
    await Promise.resolve();

    await bm.flush({ keepalive: true, maxPayloadBytes: 60_000, maxRetries: 0 });

    expect(sent).toHaveLength(2);
    expect(sent[1].events.map(event => event.event)).toEqual(['in-flight']);
    expect(options[1]).toEqual({ keepalive: true, maxRetries: 0 });

    finishNormalFlush?.();
    await normalFlush;
  });

  test('drain waits for an in-flight keepalive replay', async () => {
    let finishNormalFlush: (() => void) | undefined;
    let finishKeepalive: (() => void) | undefined;
    const normalPending = new Promise<void>(resolve => {
      finishNormalFlush = resolve;
    });
    const keepalivePending = new Promise<void>(resolve => {
      finishKeepalive = resolve;
    });
    let calls = 0;
    const transport = {
      send: mock(async () => {
        const call = ++calls;
        if (call === 1) await normalPending;
        if (call === 2) await keepalivePending;
      }),
    };
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));
    bm.add(makeEvent('in-flight'));

    const normalFlush = bm.flush();
    await Promise.resolve();
    const keepalive = bm.flush({ keepalive: true, maxPayloadBytes: 60_000, maxRetries: 0 });
    await Promise.resolve();

    let drained = false;
    const drain = bm.drain().then(() => {
      drained = true;
    });
    finishNormalFlush?.();
    await normalFlush;
    await Promise.resolve();
    expect(drained).toBe(false);

    finishKeepalive?.();
    await Promise.all([keepalive, drain]);
    expect(drained).toBe(true);
  });

  test('transient failure requeues undelivered events at the queue head in order', async () => {
    let attempts = 0;
    const transport = makeMockTransport(() => (++attempts === 1 ? { ok: false, transient: true } : OK));
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('first'));
    bm.add(makeEvent('second'));
    await bm.flush();

    // Nothing delivered; both events are back at the head of the queue, order preserved.
    expect(transport.sent).toHaveLength(1);
    expect(bm.pending).toBe(2);

    await bm.flush();

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1].events.map(event => event.event)).toEqual(['first', 'second']);
    expect(bm.pending).toBe(0);
  });

  test('events enqueued during a failed flush stay behind requeued events', async () => {
    let attempts = 0;
    const transport = makeMockTransport(() => (++attempts === 1 ? { ok: false, transient: true } : OK));
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('retried'));
    const first = bm.flush();
    await Promise.resolve();
    bm.add(makeEvent('newer'));
    await first;

    expect(bm.pending).toBe(2);
    await bm.flush();

    // The requeued head event goes out ahead of the newer one, in one batch.
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1].events.map(event => event.event)).toEqual(['retried', 'newer']);
  });

  test('a whole-batch HTTP 400 splits the batch in half and delivers valid halves', async () => {
    const transport = makeMockTransport(payload =>
      payload.events.length > 1 ? { ok: false, status: 400, transient: false } : OK
    );
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    for (const name of ['a', 'b', 'c', 'd']) bm.add(makeEvent(name));
    await bm.flush();

    const singles = transport.sent.filter(payload => payload.events.length === 1);
    expect(singles.map(payload => payload.events[0].event)).toEqual(['a', 'b', 'c', 'd']);
    expect(bm.pending).toBe(0);
  });

  test('a single event rejected with HTTP 400 is dropped, not requeued forever', async () => {
    const transport = makeMockTransport({ ok: false, status: 400, transient: false });
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('poison'));
    await bm.flush();

    expect(transport.sent).toHaveLength(1);
    expect(bm.pending).toBe(0);
  });

  test('other permanent rejections drop the batch without splitting', async () => {
    const transport = makeMockTransport({ ok: false, status: 403, transient: false });
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('a'));
    bm.add(makeEvent('b'));
    await bm.flush();

    expect(transport.sent).toHaveLength(1); // no split retries
    expect(bm.pending).toBe(0);
  });

  test('drain() terminates under persistent failure and drops the remainder', async () => {
    const transport = makeMockTransport({ ok: false, transient: true });
    bm = new BatchManager(makeConfig({ flushSize: 100 }), transport as any, createLogger(false));

    bm.add(makeEvent('stuck'));
    await bm.drain();

    // Every round failed, but drain gave up instead of looping forever.
    expect(transport.sent.length).toBeGreaterThanOrEqual(3);
    expect(bm.pending).toBe(0);
  });

  test('legacy transports that return nothing are treated as delivered', async () => {
    const sent: BatchPayload[] = [];
    const transport = { send: mock(async (payload: BatchPayload) => void sent.push(payload)) };
    bm = new BatchManager(makeConfig(), transport as any, createLogger(false));

    bm.add(makeEvent('legacy'));
    await bm.flush();

    expect(sent).toHaveLength(1);
    expect(bm.pending).toBe(0);
  });
});
