import { describe, expect, test } from 'bun:test';
import { resolveAlitycsConfig } from '../../src/config';
import { buildAnalyticsEvent } from '../../src/event';
import { StandaloneBatchManager } from '../../src/standalone-batch-manager';
import type { HttpTransport, TransportResult } from '../../src/transport';
import type { BatchPayload } from '../../src/types';

describe('StandaloneBatchManager', () => {
  test('the interval lifecycle auto-flushes and start/stop are idempotent', async () => {
    let resolveSent!: () => void;
    const sent = new Promise<void>(resolve => {
      resolveSent = resolve;
    });
    const transport = {
      async send(): Promise<TransportResult> {
        resolveSent();
        return { ok: true, transient: false, status: 200 };
      },
    } as unknown as HttpTransport;
    const manager = new StandaloneBatchManager(
      resolveAlitycsConfig({ apiKey: 'key', flushInterval: 1, flushSize: 100 }),
      transport,
      { warn: () => undefined, error: () => undefined }
    );
    manager.add(buildAnalyticsEvent({ eventType: 'track', eventName: 'timer', anonymousId: 'anon' }));

    manager.start();
    manager.start();
    await sent;
    manager.stop();
    manager.stop();

    expect(await manager.flush()).toEqual({ status: 'drained', delivered: 0, pending: 0 });
  });

  test('drain delivers all outstanding events', async () => {
    const transport = {
      async send(): Promise<TransportResult> {
        return { ok: true, transient: false, status: 200 };
      },
    } as unknown as HttpTransport;
    const manager = new StandaloneBatchManager(resolveAlitycsConfig({ apiKey: 'key', flushSize: 100 }), transport, {
      warn: () => undefined,
      error: () => undefined,
    });
    manager.add(buildAnalyticsEvent({ eventType: 'track', eventName: 'drain', anonymousId: 'anon' }));

    expect(await manager.drain()).toEqual({ status: 'drained', delivered: 1, pending: 0 });
  });

  test('splits a rejected multi-event payload and delivers both children', async () => {
    const attempts: BatchPayload[] = [];
    const transport = {
      async send(payload: BatchPayload): Promise<TransportResult> {
        attempts.push(payload);
        return payload.events.length > 1
          ? { ok: false, transient: false, status: 413 }
          : { ok: true, transient: false, status: 200 };
      },
    } as unknown as HttpTransport;
    const manager = new StandaloneBatchManager(resolveAlitycsConfig({ apiKey: 'key', flushSize: 100 }), transport, {
      warn: () => undefined,
      error: () => undefined,
    });
    manager.add(buildAnalyticsEvent({ eventType: 'track', eventName: 'first', anonymousId: 'anon' }));
    manager.add(buildAnalyticsEvent({ eventType: 'track', eventName: 'second', anonymousId: 'anon' }));

    const result = await manager.flush();

    expect(attempts.map(attempt => attempt.events.length)).toEqual([2, 1, 1]);
    expect(attempts.slice(1).flatMap(attempt => attempt.events.map(event => event.event))).toEqual(['first', 'second']);
    expect(result).toEqual({ status: 'drained', delivered: 2, pending: 0 });
  });

  test('a failed keepalive replay leaves outcome ownership with the original request', async () => {
    let releaseOriginal!: () => void;
    const originalPending = new Promise<void>(resolve => {
      releaseOriginal = resolve;
    });
    let calls = 0;
    const transport = {
      async send(): Promise<TransportResult> {
        calls += 1;
        if (calls === 1) {
          await originalPending;
          return { ok: false, transient: true };
        }
        if (calls === 2) return { ok: false, transient: true };
        return { ok: true, transient: false, status: 200 };
      },
    } as unknown as HttpTransport;
    const manager = new StandaloneBatchManager(resolveAlitycsConfig({ apiKey: 'key', flushSize: 100 }), transport, {
      warn: () => undefined,
      error: () => undefined,
    });
    manager.add(buildAnalyticsEvent({ eventType: 'track', eventName: 'exit', anonymousId: 'anon' }));

    const original = manager.flush();
    await Promise.resolve();
    const keepalive = await manager.flush({ keepalive: true, maxRetries: 0 });
    expect(keepalive).toEqual({ status: 'partial', delivered: 0, pending: 1 });

    releaseOriginal();
    await original;
    const retry = await manager.flush();

    expect(calls).toBe(3);
    expect(retry).toEqual({ status: 'drained', delivered: 1, pending: 0 });
  });
});
