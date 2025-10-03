import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { BatchManager } from '../../src/batch-manager';
import type { AnalyticsEvent, ResolvedConfig, BatchPayload } from '../../src/types';
import { createLogger } from '../../src/logger';

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
    eventId: `evt_${Math.random()}`,
    event: name,
    eventType: 'track',
    anonymousId: 'anon_123',
    sessionId: 'sess_123',
    timestamp: Date.now(),
    properties: {},
    context: { sdkVersion: '1.0.0', sdkLanguage: 'typescript' },
  };
}

function makeMockTransport() {
  const sent: BatchPayload[] = [];
  return {
    send: mock(async (payload: BatchPayload) => {
      sent.push(payload);
    }),
    sent,
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
});
