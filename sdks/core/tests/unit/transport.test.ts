import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { HttpTransport } from '../../src/transport';
import type { BatchPayload } from '../../src/types';
import { createLogger } from '../../src/logger';

function makePayload(n = 1): BatchPayload {
  return {
    batchId: `batch_test-${n}`,
    sentAt: Date.now(),
    events: [],
  };
}

describe('HttpTransport', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  test('sends POST with correct headers', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;

    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'test-key-123',
      maxRetries: 0,
      logger: createLogger(false),
    });

    await transport.send(makePayload());

    expect(capturedUrl).toBe('https://api.test.com/events');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as any)['Authorization']).toBe('Bearer test-key-123');
    expect((capturedInit?.headers as any)['Content-Type']).toBe('application/json');

    restoreFetch();
  });

  test('does not retry on 4xx (except 429)', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response('Bad Request', { status: 400 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());
    expect(fetchCount).toBe(1);

    restoreFetch();
  });

  test('retries on 429', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      if (fetchCount < 3) return new Response('Too Many Requests', { status: 429 });
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());
    expect(fetchCount).toBe(3);

    restoreFetch();
  });

  test('retries on 500', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      if (fetchCount < 2) return new Response('Server Error', { status: 500 });
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());
    expect(fetchCount).toBe(2);

    restoreFetch();
  });

  test('retries on network error', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      if (fetchCount < 2) throw new Error('Network error');
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'key',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload());
    expect(fetchCount).toBe(2);

    restoreFetch();
  });

  test('stops retrying after maxRetries exhausted', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response('Server Error', { status: 500 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'key',
      maxRetries: 2,
      logger: createLogger(false),
    });

    // Should not throw — best effort
    await transport.send(makePayload());
    expect(fetchCount).toBe(3); // initial + 2 retries

    restoreFetch();
  });

  test('sends JSON body', async () => {
    let capturedBody: string | undefined;
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = init.body;
      return new Response('OK', { status: 200 });
    }) as any;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'key',
      maxRetries: 0,
      logger: createLogger(false),
    });

    const payload = makePayload();
    await transport.send(payload);

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.batchId).toBe(payload.batchId);
    expect(parsed.events).toEqual([]);

    restoreFetch();
  });
});
