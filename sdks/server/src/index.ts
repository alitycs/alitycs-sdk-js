import {
  BatchManager,
  EventDeduplicator,
  HttpTransport,
  RESERVED_EVENT_NAMES,
  buildAnalyticsEvent,
  createLogger,
  resolveAlitycsConfig,
  validateRevenuePayload,
  validateEvent,
  type AnalyticsEvent,
  type EventType,
  type FlushResult,
  type ResolvedConfig,
  type AlitycsConfig,
  type RevenuePayload,
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

export interface AlitycsServerConfig extends Omit<
  AlitycsConfig,
  "apiKey" | "batching" | "sessionTimeout"
> {
  apiKey: string;
  /**
   * Drain the queue after every emitting call, so a crashing request handler never
   * loses its event. Long-lived workers may set false and flush on their own cadence.
   */
  drainPerCall?: boolean;
}

interface ResolvedServerConfig extends ResolvedConfig {
  drainPerCall: boolean;
}

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
    this.batchManager = new BatchManager(config, this.transport, this.logger);
    this.batchManager.start();
  }

  static init(config: AlitycsServerConfig): AlitycsServer {
    const { drainPerCall = true, ...coreConfig } = config;
    const resolved = resolveAlitycsConfig({
      ...coreConfig,
      batching: true,
      sessionTimeout: 30 * 60 * 1000,
    });
    return new AlitycsServer({ ...resolved, drainPerCall });
  }

  track(
    identity: CallIdentity,
    eventName: string,
    properties?: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<FlushResult> {
    return this.enqueue(identity, "track", eventName, properties, options);
  }

  /** Emits an identify event while keeping identity explicit per call. */
  identify(
    identity: CallIdentity,
    userId: string,
    traits?: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<FlushResult> {
    if (!NON_BLANK(userId))
      throw new Error("identify requires a non-blank userId");
    return this.enqueue(
      identity,
      "identify",
      "identify",
      { userId, ...traits },
      options,
    );
  }

  captureError(
    identity: CallIdentity,
    errorName: string,
    properties?: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<FlushResult> {
    return this.enqueue(identity, "error", errorName, properties, options);
  }

  /** Trusted revenue ingestion for server-only secret keys. */
  trackRevenue(
    identity: CallIdentity,
    payload: RevenuePayload,
    properties?: Record<string, unknown>,
    options?: ServerEventOptions,
  ): Promise<FlushResult> {
    validateRevenuePayload(payload);
    return this.enqueue(
      identity,
      "track",
      `revenue_${payload.kind}`,
      properties,
      options,
      payload,
    );
  }

  /** Links `previousId` to this call's identity so downstream analytics merge the histories. */
  alias(
    identity: CallIdentity,
    previousId: string,
    options?: ServerEventOptions,
  ): Promise<FlushResult> {
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
  ): Promise<FlushResult> {
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
  ): Promise<FlushResult> {
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
  ): Promise<FlushResult> {
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

  flush(): Promise<FlushResult> {
    return this.batchManager.flush();
  }

  shutdown(): Promise<FlushResult> {
    this.batchManager.stop();
    return this.batchManager.drain().then((result) => {
      if (result.status !== "drained") this.batchManager.releasePersistence();
      this.deduplicator.clear();
      this.shutDown = true;
      return result;
    });
  }

  stats() {
    return this.batchManager.stats();
  }

  quarantinedEvents() {
    return this.batchManager.quarantinedEvents();
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
    revenue?: RevenuePayload,
  ): Promise<FlushResult> {
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
      return Promise.resolve({
        status: this.pending === 0 ? "drained" : "partial",
        delivered: 0,
        pending: this.pending,
      });
    }

    // No ambient session exists server-side; no cross-call timestamp clamp either —
    // interleaved requests must not shift each other's timestamps.
    const event: AnalyticsEvent = buildAnalyticsEvent({
      eventType: type,
      eventName: name,
      userId,
      anonymousId: anonymousId ?? "",
      properties,
      revenue,
      dedupeKey: options?.dedupeKey,
    });

    const rejection = validateEvent(event);
    if (rejection) throw new Error(`Invalid analytics event: ${rejection}`);

    this.batchManager.add(event);
    if (!this.config.drainPerCall) {
      return Promise.resolve({
        status: this.pending === 0 ? "drained" : "partial",
        delivered: 0,
        pending: this.pending,
      });
    }
    return this.batchManager.drain().then((result) => {
      if (result.status !== "drained" && this.config.persistence === false) {
        throw new AlitycsDeliveryError(result);
      }
      return result;
    });
  }
}

export class AlitycsDeliveryError extends Error {
  constructor(public readonly result: FlushResult) {
    super(
      `Alitycs delivery did not drain (${result.status}, ${result.pending} pending event(s))`,
    );
    this.name = "AlitycsDeliveryError";
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
