import {
  DEFAULTS,
  BatchManager,
  EventDeduplicator,
  HttpTransport,
  RESERVED_EVENT_NAMES,
  buildAnalyticsEvent,
  createLogger,
  validateEvent,
  type AnalyticsEvent,
  type EventType,
  type ResolvedConfig,
} from "@alitycs/core";

/**
 * Stateful-free server analytics for Node and Bun. Unlike `@alitycs/core`, there is
 * no ambient identity: a shared client in one process can safely serve interleaved
 * requests because every call carries its own {@link CallIdentity} and nothing is
 * stored between calls.
 *
 * Validation is fail-fast — invalid input throws synchronously at the call site
 * instead of silently dropping events, because server-side callers (billing,
 * lifecycle emails) care more about losing data than about never throwing.
 */

/**
 * Who an event belongs to. At least one of the two ids is required on every call;
 * supply both when the request has an anonymous cookie plus a logged-in user.
 */
export interface CallIdentity {
  /** Identified user. Wins over `anonymousId` during downstream resolution. */
  userId?: string;
  /** Anonymous device or app-scoped id. */
  anonymousId?: string;
}

export interface ServerEventOptions {
  /** Coalesces repeated identical calls inside the dedupe window. */
  dedupeKey?: string;
  /** Dedupe window; default 500ms. */
  dedupeWindowMs?: number;
}

export interface AlitycsServerConfig {
  apiKey: string;
  endpoint?: string;
  flushInterval?: number;
  flushSize?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  /** Per-request abort timeout in milliseconds. Defaults to 10_000. */
  requestTimeout?: number;
  debug?: boolean;
  /**
   * Drain the queue after every emitting call, so a crashing request handler never
   * loses its event. Long-lived workers may set false and flush on their own cadence.
   */
  drainPerCall?: boolean;
}

interface ResolvedServerConfig {
  apiKey: string;
  endpoint: string;
  flushInterval: number;
  flushSize: number;
  maxQueueSize: number;
  maxRetries: number;
  requestTimeout?: number;
  debug: boolean;
  drainPerCall: boolean;
}

const SERVER_DEFAULTS: Omit<ResolvedServerConfig, "apiKey"> = {
  endpoint: DEFAULTS.endpoint,
  flushInterval: DEFAULTS.flushInterval,
  flushSize: DEFAULTS.flushSize,
  maxQueueSize: DEFAULTS.maxQueueSize,
  maxRetries: DEFAULTS.maxRetries,
  debug: false,
  drainPerCall: true,
};

const NON_BLANK = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export class AlitycsServer {
  private config: ResolvedServerConfig;
  private transport: HttpTransport;
  private batchManager: BatchManager;
  private logger: ReturnType<typeof createLogger>;
  private deduplicator = new EventDeduplicator();
  private shutDown = false;

  private constructor(config: ResolvedServerConfig) {
    this.config = config;
    this.logger = createLogger(config.debug);
    this.transport = new HttpTransport({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      maxRetries: config.maxRetries,
      requestTimeout: config.requestTimeout,
      logger: this.logger,
    });
    this.batchManager = new BatchManager(
      { ...DEFAULTS, ...config } as ResolvedConfig,
      this.transport,
      this.logger,
    );
    this.batchManager.start();
  }

  static init(config: AlitycsServerConfig): AlitycsServer {
    if (!config.apiKey || config.apiKey.trim() === "") {
      throw new Error("apiKey is required");
    }
    return new AlitycsServer({ ...SERVER_DEFAULTS, ...config });
  }

  track(
    identity: CallIdentity,
    eventName: string,
    properties?: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<void> {
    return this.enqueue(identity, "track", eventName, properties, options);
  }

  captureError(
    identity: CallIdentity,
    errorName: string,
    properties?: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<void> {
    return this.enqueue(identity, "error", errorName, properties, options);
  }

  /** Links `previousId` to this call's identity so downstream analytics merge the histories. */
  alias(
    identity: CallIdentity,
    previousId: string,
    options?: ServerEventOptions,
  ): Promise<void> {
    if (!NON_BLANK(previousId))
      throw new Error("alias requires a non-blank previousId");
    return this.enqueue(
      identity,
      "identify",
      RESERVED_EVENT_NAMES.alias,
      { previousId },
      options,
    );
  }

  /** Latest-wins person traits ('$set'). */
  set(
    identity: CallIdentity,
    traits: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<void> {
    assertTraits(traits);
    return this.enqueue(
      identity,
      "identify",
      RESERVED_EVENT_NAMES.set,
      traits,
      options,
    );
  }

  /** First-wins person traits ('$set_once'): downstream keeps the earliest value per key. */
  setOnce(
    identity: CallIdentity,
    traits: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<void> {
    assertTraits(traits);
    return this.enqueue(
      identity,
      "identify",
      RESERVED_EVENT_NAMES.setOnce,
      traits,
      options,
    );
  }

  /** Removes person traits ('$unset'); the key list travels as JSON in '$keys'. */
  unset(
    identity: CallIdentity,
    keys: string[],
    options?: ServerEventOptions,
  ): Promise<void> {
    if (!Array.isArray(keys))
      throw new Error("unset requires an array of trait keys");
    const removable = keys.filter(
      (key) => typeof key === "string" && key.trim() !== "",
    );
    if (removable.length === 0)
      throw new Error("unset requires at least one non-blank key");
    if (removable.length > 50)
      throw new Error("unset supports at most 50 keys per call");
    return this.enqueue(
      identity,
      "identify",
      RESERVED_EVENT_NAMES.unset,
      { $keys: JSON.stringify(removable) },
      options,
    );
  }

  /** Events queued and not yet delivered. */
  get pending(): number {
    return this.batchManager.pending;
  }

  /** True once shutdown() has completed; a shut-down client must not be reused. */
  get isShutdown(): boolean {
    return this.shutDown;
  }

  async flush(): Promise<void> {
    await this.batchManager.flush();
  }

  async shutdown(): Promise<void> {
    this.batchManager.stop();
    await this.batchManager.drain();
    this.deduplicator.clear();
    this.shutDown = true;
  }

  /**
   * Builds and queues one event from per-call inputs only. Deliberately not async:
   * validation throws synchronously where the caller can see it, and the returned
   * promise is only ever the (optional) drain.
   */
  private enqueue(
    identity: CallIdentity,
    type: EventType,
    name: string,
    properties: Record<string, unknown> | undefined,
    options: ServerEventOptions | undefined,
  ): Promise<void> {
    if (this.shutDown)
      throw new Error("Client has been shut down; init() a new instance");
    if (!name || name.trim() === "") throw new Error("Event name is required");

    const userId = NON_BLANK(identity?.userId);
    const anonymousId = NON_BLANK(identity?.anonymousId);
    if (!userId && !anonymousId) {
      throw new Error(
        "@alitycs/server requires userId or anonymousId on every call",
      );
    }

    if (
      options?.dedupeKey &&
      this.deduplicator.isDuplicate(
        options.dedupeKey,
        options.dedupeWindowMs ?? 500,
      )
    ) {
      return Promise.resolve();
    }

    // No ambient session exists server-side; no cross-call timestamp clamp either —
    // interleaved requests must not shift each other's timestamps.
    const event: AnalyticsEvent = buildAnalyticsEvent({
      eventType: type,
      eventName: name,
      userId,
      anonymousId: anonymousId ?? "",
      properties,
      dedupeKey: options?.dedupeKey,
    });

    const rejection = validateEvent(event);
    if (rejection) throw new Error(`Invalid analytics event: ${rejection}`);

    this.batchManager.add(event);
    return this.config.drainPerCall ? this.flush() : Promise.resolve();
  }
}

function assertTraits(traits: Record<string, unknown>): void {
  if (
    !traits ||
    typeof traits !== "object" ||
    Object.keys(traits).length === 0
  ) {
    throw new Error("Trait operations require at least one trait");
  }
  const count = Object.keys(traits).length;
  if (count > 50)
    throw new Error(`At most 50 traits per call (received ${count})`);
}
