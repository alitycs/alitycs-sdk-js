import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { HttpTransport } from '../../src/transport';
import type { BatchPayload } from '../../src/types';
import { createLogger } from '../../src/logger';

function makePayload(): BatchPayload {
  return {
    batchId: 'batch_test',
    sentAt: Date.now(),
    events: [
      {
        eventId: 'evt_1',
        event: 'test',
        eventType: 'track' as const,
        anonymousId: 'anon_1',
        sessionId: 'sess_1',
        timestamp: Date.now(),
        properties: {},
        context: { sdkVersion: '1.0.0', sdkLanguage: 'typescript' },
      },
    ],
  };
}

describe('Transport Integration', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('successful send completes without error', async () => {
    globalThis.fetch = mock(async () => new Response('OK', { status: 200 })) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());
    // No error = success
  });

  test('retry with exponential backoff on 500', async () => {
    const timestamps: number[] = [];
    let attempts = 0;

    globalThis.fetch = mock(async () => {
      timestamps.push(Date.now());
      attempts++;
      if (attempts < 3) return new Response('Error', { status: 500 });
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());

    expect(attempts).toBe(3);
    // Verify exponential backoff timing (approximately)
    if (timestamps.length >= 2) {
      const firstDelay = timestamps[1] - timestamps[0];
      expect(firstDelay).toBeGreaterThanOrEqual(900); // ~1000ms with some tolerance
    }
  });

  test('4xx errors fail immediately without retry', async () => {
    let attempts = 0;

    globalThis.fetch = mock(async () => {
      attempts++;
      return new Response('Not Found', { status: 404 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());

    expect(attempts).toBe(1); // No retries
  });

  test('429 triggers retry', async () => {
    let attempts = 0;

    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) return new Response('Rate Limited', { status: 429 });
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());

    expect(attempts).toBe(2);
  });

  test('graceful degradation on all retries exhausted', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('Error', { status: 500 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key',
      maxRetries: 1,
      logger: createLogger(false),
    });

    // Should not throw — analytics is best-effort
    await transport.send(makePayload());
  });

  test('network errors trigger retry', async () => {
    let attempts = 0;

    globalThis.fetch = mock(async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());

    expect(attempts).toBe(2);
  });
});
