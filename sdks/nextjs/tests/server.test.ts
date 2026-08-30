import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { startCaptureServer, type CaptureServerHandle } from './helpers';

/**
 * No DOM globals are installed in this file on purpose: importing and using
 * the /server entry here is a live proof that its import graph loads and runs
 * without any DOM. The static graph guard lives in guards.test.ts.
 *
 * The module keeps one lazy singleton, so every test builds its own client
 * through `freshClient()` instead of relying on what earlier tests left
 * behind. Initialisation and validation errors throw synchronously at the
 * call site (fail-fast server semantics), so no promise-matcher subtlety is
 * involved anywhere in this file.
 */
type ServerModule = typeof import('../src/server');

let mod: ServerModule;
let capture: CaptureServerHandle;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Import must succeed with no window/document/navigator anywhere.
  mod = await import('../src/server');

  savedEnv.ALITYCS_API_KEY = process.env.ALITYCS_API_KEY;
  savedEnv.ALITYCS_ENDPOINT = process.env.ALITYCS_ENDPOINT;
  delete process.env.ALITYCS_API_KEY;
  delete process.env.ALITYCS_ENDPOINT;

  capture = startCaptureServer();
});

afterAll(async () => {
  await mod.alitycs.shutdown().catch(() => undefined);
  await capture.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  capture.requests.length = 0;
});

function events(): Array<Record<string, any>> {
  return capture.requests.flatMap(request => (request.payload as any)?.events ?? []);
}

/** Discards any existing client and seeds configuration for the next use. */
async function freshClient(config: Record<string, unknown> = {}): Promise<void> {
  await mod.alitycs.shutdown();
  mod.configureAlitycs({ endpoint: capture.url, ...config });
}

describe('@alitycs/nextjs/server', () => {
  test('refuses to emit without any API key', () => {
    // Initialisation errors throw at the call site — fail-fast beats a
    // rejected promise in a route handler.
    expect(() => mod.alitycs.track('nope')).toThrow(/ALITYCS_API_KEY|configureAlitycs/);
    expect(() => mod.alitycs.identify('still_refused')).toThrow(/ALITYCS_API_KEY|configureAlitycs/);
  });

  test('initialises from ALITYCS_API_KEY and honours ALITYCS_ENDPOINT', async () => {
    process.env.ALITYCS_API_KEY = 'pk_env_key';
    process.env.ALITYCS_ENDPOINT = capture.url;

    try {
      await mod.alitycs.track('env_init_event', { source: 'env' });

      expect(events()).toHaveLength(1);
      expect(capture.requests[0].headers.authorization).toBe('Bearer pk_env_key');
      expect(events()[0].event).toBe('env_init_event');
      expect(events()[0].eventType).toBe('track');
      expect(capture.requests[0].headers['content-type']).toContain('application/json');
      expect(mod.alitycs.actingUserId).toBeUndefined();
    } finally {
      delete process.env.ALITYCS_ENDPOINT;
      delete process.env.ALITYCS_API_KEY;
      await mod.alitycs.shutdown();
    }
  });

  test('configureAlitycs before first use is fine, after first use is an error', async () => {
    await mod.alitycs.shutdown();

    mod.configureAlitycs({ apiKey: 'pk_first', endpoint: capture.url });
    await mod.alitycs.track('configured_event');
    expect(capture.requests[0].headers.authorization).toBe('Bearer pk_first');

    expect(() => mod.configureAlitycs({ apiKey: 'pk_second' })).toThrow(/before the first event/);
  });

  test('every awaited write drains: nothing stays queued after the promise resolves', async () => {
    // Batching off makes the in-flight window observable: with batching on,
    // the write's own flush moves queued events into the send synchronously.
    await freshClient({ apiKey: 'pk_drain_probe', batching: false });

    const probe = mod.alitycs.track('pending_probe');
    // enqueue happens synchronously inside the call; the await covers the drain.
    expect(mod.alitycs.pending).toBe(1);
    await probe;
    expect(mod.alitycs.pending).toBe(0);
    expect(events()).toHaveLength(1);
  });

  test('identify is sticky: later events carry the user', async () => {
    await freshClient({ apiKey: 'pk_sticky' });
    await mod.alitycs.identify('usr_standing', { plan: 'pro' });

    const identified = events().find(event => event.eventType === 'identify');
    expect(identified?.userId).toBe('usr_standing');
    expect(identified?.properties.plan).toBe('pro');
    expect(identified?.properties.userId).toBe('usr_standing');

    await mod.alitycs.track('after_identify');
    expect(events().at(-1)?.userId).toBe('usr_standing');
    expect(mod.alitycs.actingUserId).toBe('usr_standing');
  });

  test('options.userId scopes one event and restores the standing identity', async () => {
    await freshClient({ apiKey: 'pk_scope' });
    await mod.alitycs.identify('usr_standing');

    await mod.alitycs.track('scoped_event', { n: 1 }, { userId: 'usr_scoped' });

    expect(events().at(-1)?.userId).toBe('usr_scoped');
    // The standing identity survived the scoped write...
    expect(mod.alitycs.actingUserId).toBe('usr_standing');

    await mod.alitycs.track('back_to_standing');
    expect(events().at(-1)?.userId).toBe('usr_standing');
  });

  test('scoped userId leaves anonymous events anonymous on a client with no identity', async () => {
    await freshClient({ apiKey: 'pk_anon' });
    // A standing identity must not survive into this scenario.
    await mod.alitycs.identify('transient');
    await mod.alitycs.reset();
    expect(mod.alitycs.actingUserId).toBeUndefined();

    await mod.alitycs.track('anonymous_before', {}, { userId: 'guest_1' });
    await mod.alitycs.track('anonymous_after');

    const before = events().find(event => event.event === 'anonymous_before');
    const after = events().find(event => event.event === 'anonymous_after');
    expect(before?.userId).toBe('guest_1');
    expect(after?.userId).toBeUndefined();
    // Clearing the scope must not rotate the session: the two events share it.
    expect(after?.sessionId).toBe(before?.sessionId);
    expect(after?.anonymousId).toBe(before?.anonymousId);
  });

  test('captureError emits eventType error and page emits eventType page', async () => {
    await freshClient({ apiKey: 'pk_kinds' });
    await mod.alitycs.captureError('srv_error', { code: 'E_TEST' }, { userId: 'err_user' });
    await mod.alitycs.page('/server-rendered', undefined, { userId: 'page_user' });

    const error = events().find(event => event.event === 'srv_error');
    const page = events().find(event => event.event === '/server-rendered');
    expect(error?.eventType).toBe('error');
    expect(error?.userId).toBe('err_user');
    expect(page?.eventType).toBe('page');
    expect(page?.userId).toBe('page_user');
  });

  test('dedupe options pass through to the core pipeline', async () => {
    await freshClient({ apiKey: 'pk_dedupe' });
    await mod.alitycs.track('deduped', { attempt: 1 }, { dedupeKey: 'once' });
    await mod.alitycs.track('deduped', { attempt: 2 }, { dedupeKey: 'once' });

    const arrivals = events().filter(event => event.event === 'deduped');
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].properties.attempt).toBe('1');
  });

  test('global properties attach to events until removed or cleared', async () => {
    await freshClient({ apiKey: 'pk_globals' });

    mod.alitycs.setGlobalProperties({ suite: 'server-test' });
    expect(mod.alitycs.getGlobalProperties()).toEqual({ suite: 'server-test' });
    await mod.alitycs.track('with_globals');
    expect(events().at(-1)?.properties.suite).toBe('server-test');

    mod.alitycs.removeGlobalProperties(['suite']);
    await mod.alitycs.track('without_globals');
    expect(events().at(-1)?.properties.suite).toBeUndefined();

    mod.alitycs.setGlobalProperties({ a: '1', b: '2' });
    mod.alitycs.clearGlobalProperties();
    expect(mod.alitycs.getGlobalProperties()).toEqual({});
  });

  test('trackRevenue emits the transaction payload and validates input', async () => {
    await freshClient({ apiKey: 'pk_revenue' });
    await mod.alitycs.trackRevenue(
      {
        version: 1,
        kind: 'transaction',
        factId: 'fact_server_test',
        amount: '19.99',
        currency: 'USD',
      },
      { context: 'test' },
      { userId: 'payer_1' }
    );

    const revenue = events().find(event => event.event === 'revenue_transaction');
    expect(revenue?.eventType).toBe('track');
    expect(revenue?.userId).toBe('payer_1');
    expect(revenue?.revenue).toMatchObject({
      version: 1,
      kind: 'transaction',
      factId: 'fact_server_test',
      amount: '19.99',
      currency: 'USD',
    });

    const invalid = () =>
      mod.alitycs.trackRevenue({
        version: 1,
        kind: 'transaction',
        factId: 'bad_currency',
        amount: '1.00',
        currency: 'usd',
      });
    expect(invalid).toThrow(/currency/i);
  });

  test('shutdown drains everything enqueued, then allows a fresh configuration', async () => {
    await mod.alitycs.shutdown();
    // A client whose flushSize is never reached: only the awaited writes and
    // the shutdown drain can deliver these.
    mod.configureAlitycs({ apiKey: 'pk_drain', endpoint: capture.url, flushSize: 100 });

    await mod.alitycs.identify('usr_drain');
    await mod.alitycs.track('drain_me');
    expect(events()).toHaveLength(2);

    await mod.alitycs.shutdown();
    expect(events()).toHaveLength(2);

    // Re-initialisation works and uses the new key.
    mod.configureAlitycs({ apiKey: 'pk_after_shutdown', endpoint: capture.url });
    await mod.alitycs.track('fresh_client');
    expect(capture.requests.at(-1)?.headers.authorization).toBe('Bearer pk_after_shutdown');
    expect(events().at(-1)?.event).toBe('fresh_client');
  });

  test('shutdown clears configuration before the next client resolves environment defaults', async () => {
    await freshClient({ apiKey: 'pk_before_shutdown' });
    await mod.alitycs.track('before_shutdown');
    await mod.alitycs.shutdown();

    process.env.ALITYCS_API_KEY = 'pk_env_after_shutdown';
    process.env.ALITYCS_ENDPOINT = capture.url;
    try {
      mod.configureAlitycs({ endpoint: capture.url });
      await mod.alitycs.track('after_shutdown');
      expect(capture.requests.at(-1)?.headers.authorization).toBe('Bearer pk_env_after_shutdown');
    } finally {
      delete process.env.ALITYCS_ENDPOINT;
      delete process.env.ALITYCS_API_KEY;
      await mod.alitycs.shutdown();
    }
  });

  test('shutdown with no client is a no-op', async () => {
    await mod.alitycs.shutdown();
    await mod.alitycs.shutdown(); // idempotent
  });

  test('exposes delivery stats, quarantine access, and the additive delivery error type', async () => {
    await freshClient({ apiKey: 'pk_observability' });
    expect(mod.alitycs.actingUserId).toBeUndefined();
    expect(mod.alitycs.stats()).toMatchObject({ queueDepth: 0, inFlight: 0, lastError: null });
    expect(mod.alitycs.quarantinedEvents()).toEqual([]);

    const error = new mod.AlitycsDeliveryError({ status: 'partial', delivered: 0, pending: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('partial');
    await mod.alitycs.shutdown();
  });
});
