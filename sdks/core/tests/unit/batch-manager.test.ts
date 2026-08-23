import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { BatchManager } from '../../src/batch-manager';
import type { AnalyticsEvent, ResolvedConfig, BatchPayload } from '../../src/types';
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
    context: { sdkVersion: '1.0.1', sdkLanguage: 'typescript' },
  };
}

function makeMockTransport() {
  const sent: BatchPayload[] = [];
  const options: unknown[] = [];
  return {
    send: mock(async (payload: BatchPayload, sendOptions?: unknown) => {
      sent.push(payload);
      options.push(sendOptions);
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

  test('keepalive flush sends newly queued events while a normal flush is in flight', async () => {
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
    expect(sent[1].events.map(event => event.event)).toEqual(['page-exit', 'normal']);
    expect(options[1]).toEqual({ keepalive: true, maxRetries: 0 });
    expect(bm.pending).toBe(0);

    finishNormalFlush?.();
    await normalFlush;
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
});
