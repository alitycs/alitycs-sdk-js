import { Alitycs, DEFAULTS, type AlitycsConfig, type ResolvedConfig, type RevenuePayload } from '@alitycs/core';

/**
 * Server-side tracking for Next.js: route handlers, server actions, and
 * middleware. Wraps `@alitycs/core` — deliberately NOT `@alitycs/browser`,
 * whose DOM-touching modules must never appear anywhere in this entry's import
 * graph (a Server Component or middleware build would break at the consumer).
 *
 * Server contexts are short-lived, so every emitting call drains the queue
 * before its promise resolves and `shutdown()` is safe to call at the end of
 * a request, action, or worker request.
 */

/** Options accepted by the emitting methods. */
export interface ServerEventOptions {
  /** Coalesces repeated identical events inside the dedupe window. */
  dedupeKey?: string;
  /** Dedupe window; default 500ms. */
  dedupeWindowMs?: number;
  /**
   * Attaches this one event to a user without changing the client's standing
   * identity — unrelated concurrent requests will not inherit it. To identify
   * persistently, use {@link AlitycsServer.identify}.
   */
  userId?: string;
}

/** Client configuration. `apiKey` falls back to the `ALITYCS_API_KEY` env var. */
export interface AlitycsServerConfig extends Omit<AlitycsConfig, 'apiKey'> {
  apiKey?: string;
}

/**
 * The core client plus one capability `@alitycs/core` keeps private: switching
 * identity silently. `identify()` always emits an event, which is correct for
 * a real identification but wrong for scoping a single event to a user — that
 * has to be reversible without touching the wire.
 */
class ScopedIdentityClient extends Alitycs {
  protected constructor(config: ResolvedConfig) {
    super(config);
  }

  static override init(config: AlitycsConfig): ScopedIdentityClient {
    // Callers go through AlitycsServer.resolve(), which has already produced a
    // clear error for a missing key.
    return new ScopedIdentityClient({ ...DEFAULTS, ...config } as ResolvedConfig);
  }

  /**
   * Identity lives in a private core field that `enqueue()` snapshots into
   * every event; `SessionManager` mirrors it but does not drive emission, so
   * the accessor has to reach the field itself. The sibling package is
   * workspace-pinned and the scoped-user tests fail loudly if it moves.
   */
  private get identity(): { userId?: string } {
    return this as unknown as { userId?: string };
  }

  /** The user id currently attached to every emitted event, if any. */
  get actingUserId(): string | undefined {
    return this.identity.userId;
  }

  /**
   * Sets or clears the user id without emitting an identify event, keeping the
   * session mirror consistent with what `identify()` and `reset()` leave
   * behind.
   */
  set actingUserId(userId: string | undefined) {
    if (this.identity.userId === userId) return;
    this.identity.userId = userId;
    if (userId === undefined) {
      this.sessionManager.getSession().userId = undefined;
    } else {
      this.sessionManager.setUserId(userId);
    }
  }
}

const ENV_API_KEY = 'ALITYCS_API_KEY';
const ENV_ENDPOINT = 'ALITYCS_ENDPOINT';

let instance: ScopedIdentityClient | undefined;
let overrides: AlitycsServerConfig | undefined;

function readEnv(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== '' ? value : undefined;
}

/**
 * Pre-seed configuration before the first tracked event. Throws if the client
 * already exists — configuration is read exactly once, at first use, and a
 * silently ignored call here would strand events on the wrong endpoint.
 */
export function configureAlitycs(config: AlitycsServerConfig = {}): void {
  if (instance) {
    throw new Error(
      'configureAlitycs() must be called before the first event; call alitycs.shutdown() to discard the current client first'
    );
  }
  overrides = { ...overrides, ...config };
}

export class AlitycsServer {
  /** The user id currently attached to emitted events without an explicit `userId`, if any. */
  get actingUserId(): string | undefined {
    return this.resolve().actingUserId;
  }

  /** Events queued or in flight and not yet delivered. */
  get pending(): number {
    return this.resolve().pending;
  }

  track(eventName: string, properties?: Record<string, unknown>, options?: ServerEventOptions): Promise<void> {
    return this.emit(options?.userId, client => client.track(eventName, properties, options));
  }

  captureError(errorName: string, properties?: Record<string, unknown>, options?: ServerEventOptions): Promise<void> {
    return this.emit(options?.userId, client => client.captureError(errorName, properties, options));
  }

  page(name?: string, properties?: Record<string, unknown>, options?: ServerEventOptions): Promise<void> {
    return this.emit(options?.userId, client => client.page(name, properties, options));
  }

  /**
   * Identifies the standing user: every later event carries this id until
   * {@link reset} or another identify. Emits an `identify` event, like every
   * other SDK.
   */
  identify(userId: string, traits?: Record<string, unknown>): Promise<void> {
    return this.emit(undefined, client => client.identify(userId, traits));
  }

  /** Trusted revenue ingestion — requires a secret key with `revenue:write`. */
  trackRevenue(
    payload: RevenuePayload,
    properties?: Record<string, unknown>,
    options?: ServerEventOptions
  ): Promise<void> {
    return this.emit(options?.userId, client => client.trackRevenue(payload, properties));
  }

  /** Clears the standing identity (user id, session, anonymous id). */
  reset(): void {
    this.resolve().reset();
  }

  setGlobalProperties(properties: Record<string, unknown>): void {
    this.resolve().setGlobalProperties(properties);
  }

  getGlobalProperties(): Record<string, unknown> {
    return this.resolve().getGlobalProperties();
  }

  removeGlobalProperties(keys: string[]): void {
    this.resolve().removeGlobalProperties(keys);
  }

  clearGlobalProperties(): void {
    this.resolve().clearGlobalProperties();
  }

  flush(): Promise<void> {
    return this.resolve().flush();
  }

  /**
   * Drains everything queued, then discards the client so the next call
   * re-initialises from environment or {@link configureAlitycs}. Safe to call
   * at the end of a serverless invocation; nothing enqueued before it is lost.
   */
  shutdown(): Promise<void> {
    const client = instance;
    if (!client) return Promise.resolve();
    instance = undefined;
    return client.shutdown();
  }

  protected resolve(): ScopedIdentityClient {
    if (!instance) {
      const { apiKey: overrideKey, endpoint: overrideEndpoint, ...rest } = overrides ?? {};
      const apiKey = overrideKey ?? readEnv(ENV_API_KEY);
      if (!apiKey) {
        throw new Error(
          `@alitycs/nextjs/server requires an API key: set ${ENV_API_KEY} or call configureAlitycs({ apiKey }) before first use`
        );
      }
      const endpoint = overrideEndpoint ?? readEnv(ENV_ENDPOINT);
      instance = ScopedIdentityClient.init({
        ...(rest as Omit<AlitycsConfig, 'apiKey' | 'endpoint'>),
        ...(endpoint ? { endpoint } : {}),
        apiKey,
      });
    }
    return instance;
  }

  /**
   * Writes one event under `userId`, restoring the standing identity
   * afterwards so a shared server-side client never leaks one request's user
   * into another's events, then drains the queue.
   *
   * Deliberately not `async`: initialisation and payload validation throw
   * synchronously at the call site — fail-fast in a route handler is worth
   * more than a rejected promise nobody awaited — and the returned promise is
   * only ever the drain.
   */
  private emit(userId: string | undefined, write: (client: ScopedIdentityClient) => void): Promise<void> {
    const client = this.resolve();
    const previous = client.actingUserId;
    const switching = userId !== undefined && userId !== previous;
    if (switching) client.actingUserId = userId;
    try {
      write(client);
    } finally {
      if (switching) client.actingUserId = previous;
    }
    return client.flush();
  }
}

/** Shared server client configured from `ALITYCS_API_KEY` / `ALITYCS_ENDPOINT` or {@link configureAlitycs}. */
export const alitycs: AlitycsServer = new AlitycsServer();
