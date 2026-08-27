import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { HttpTransport, parseRetryAfterMs } from '../../src/transport';
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

  test('uses keepalive without moving the publishable key into the URL', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl = '';
    globalThis.fetch = mock(async (url: URL | RequestInfo, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response('OK', { status: 200 });
    }) as unknown as typeof fetch;

    const transport = new HttpTransport({
      endpoint: 'https://api.test.com/events',
      apiKey: 'publishable-secret',
      maxRetries: 3,
      logger: createLogger(false),
    });

    await transport.send(makePayload(), { keepalive: true, maxRetries: 0 });

    expect(capturedUrl).toBe('https://api.test.com/events');
    expect(capturedUrl).not.toContain('publishable-secret');
    expect(capturedInit?.keepalive).toBe(true);
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe('Bearer publishable-secret');

    restoreFetch();
  });

  describe('send() outcome results', () => {
    test('resolves with ok:true and the status on success', async () => {
      globalThis.fetch = mock(async () => new Response('OK', { status: 201 })) as any;

      const transport = new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries: 3,
        logger: createLogger(false),
      });

      const result = await transport.send(makePayload());
      expect(result.ok).toBe(true);
      expect(result.status).toBe(201);
      expect(result.transient).toBe(false);

      restoreFetch();
    });

    test('reports non-429 4xx rejections as permanent with their status', async () => {
      globalThis.fetch = mock(async () => new Response('Bad Request', { status: 400 })) as any;

      const transport = new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries: 3,
        logger: createLogger(false),
      });

      const result = await transport.send(makePayload());
      expect(result).toMatchObject({ ok: false, status: 400, transient: false });

      restoreFetch();
    });

    test('reports exhausted retries on 5xx as transient without a status of its own', async () => {
      globalThis.fetch = mock(async () => new Response('Server Error', { status: 500 })) as any;

      const transport = new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries: 1,
        logger: createLogger(false),
      });

      const result = await transport.send(makePayload());
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);

      restoreFetch();
    });

    test('reports network failures as transient after retries are exhausted', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('Network down');
      }) as any;

      const transport = new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries: 0,
        logger: createLogger(false),
      });

      const result = await transport.send(makePayload());
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);

      restoreFetch();
    });
  });

  describe('Retry-After on 429', () => {
    function makeTransport(sleep: (ms: number) => Promise<void>, maxRetries = 3): HttpTransport {
      return new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries,
        logger: createLogger(false),
        sleep,
      });
    }

    test('honours a seconds-valued Retry-After over the default backoff', async () => {
      const sleeps: number[] = [];
      let fetchCount = 0;
      globalThis.fetch = mock(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '2' } });
        }
        return new Response('OK', { status: 200 });
      }) as any;

      await makeTransport(async ms => {
        sleeps.push(ms);
      }).send(makePayload());

      expect(fetchCount).toBe(2);
      // Retry-After replaces the default 1s backoff and is honoured in full.
      expect(sleeps).toEqual([2000]);

      restoreFetch();
    });

    test('honours a huge Retry-After in bounded 60s sleep slices', async () => {
      const sleeps: number[] = [];
      let fetchCount = 0;
      globalThis.fetch = mock(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '3600' } });
        }
        return new Response('OK', { status: 200 });
      }) as any;

      await makeTransport(async ms => {
        sleeps.push(ms);
      }).send(makePayload());

      expect(fetchCount).toBe(2);
      expect(sleeps).toHaveLength(60);
      expect(sleeps.every(ms => ms === 60_000)).toBe(true);

      restoreFetch();
    });

    test('honours an HTTP-date Retry-After', async () => {
      const sleeps: number[] = [];
      let fetchCount = 0;
      globalThis.fetch = mock(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          const when = new Date(Date.now() + 3000);
          return new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': when.toUTCString() },
          });
        }
        return new Response('OK', { status: 200 });
      }) as any;

      await makeTransport(async ms => {
        sleeps.push(ms);
      }).send(makePayload());

      expect(fetchCount).toBe(2);
      // toUTCString() truncates milliseconds, so the honoured wait lands anywhere in
      // (2s, 3s]; anything below the default 1s backoff would mean the date was ignored.
      expect(sleeps[0]).toBeGreaterThan(1000);
      expect(sleeps[0]).toBeLessThanOrEqual(3000);

      restoreFetch();
    });

    test('falls back to the default backoff when the 429 carries no Retry-After', async () => {
      const sleeps: number[] = [];
      let fetchCount = 0;
      globalThis.fetch = mock(async () => {
        fetchCount++;
        if (fetchCount === 1) return new Response('Too Many Requests', { status: 429 });
        return new Response('OK', { status: 200 });
      }) as any;

      await makeTransport(async ms => {
        sleeps.push(ms);
      }).send(makePayload());

      expect(fetchCount).toBe(2);
      expect(sleeps).toEqual([1000]);

      restoreFetch();
    });

    test('a Retry-After applies only to the attempt that follows its 429', async () => {
      const sleeps: number[] = [];
      let fetchCount = 0;
      globalThis.fetch = mock(async () => {
        fetchCount++;
        if (fetchCount === 1)
          return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '2' } });
        if (fetchCount === 2) return new Response('Server Error', { status: 500 });
        return new Response('OK', { status: 200 });
      }) as any;

      await makeTransport(async ms => {
        sleeps.push(ms);
      }).send(makePayload());

      expect(fetchCount).toBe(3);
      // First wait honours Retry-After: 2; the second falls back to the doubling schedule.
      expect(sleeps).toEqual([2000, 2000]);

      restoreFetch();
    });

    test('parseRetryAfterMs rejects garbage and past dates clamp to zero', () => {
      const now = 1_700_000_000_000;
      expect(parseRetryAfterMs(null, now)).toBeNull();
      expect(parseRetryAfterMs('', now)).toBeNull();
      expect(parseRetryAfterMs('soon', now)).toBeNull();
      expect(parseRetryAfterMs(' 5 ', now)).toBe(5000);
      expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
    });
  });

  describe('request timeout', () => {
    test('aborts a hung request and reports a transient failure', async () => {
      globalThis.fetch = mock(
        (_url: any, init: any) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          })
      ) as any;

      const transport = new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries: 0,
        requestTimeout: 10,
        logger: createLogger(false),
      });

      const result = await transport.send(makePayload());
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);

      restoreFetch();
    });

    test('passes an abort signal to fetch and clears the timer after success', async () => {
      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = mock(async (_url: any, init: any) => {
        capturedSignal = init.signal;
        return new Response('OK', { status: 200 });
      }) as any;

      const transport = new HttpTransport({
        endpoint: 'https://api.test.com/events',
        apiKey: 'key',
        maxRetries: 0,
        requestTimeout: 5_000,
        logger: createLogger(false),
      });

      const result = await transport.send(makePayload());

      expect(result.ok).toBe(true);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(false);

      restoreFetch();
    });
  });
});
