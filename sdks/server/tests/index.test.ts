import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { AlitycsDeliveryError, AlitycsServer } from "../src/index";
import {
  MemoryEventStorage,
  eventStorageKey,
  type BatchPayload,
} from "@alitycs/core";

describe("AlitycsServer", () => {
  let originalFetch: typeof globalThis.fetch;
  let sentPayloads: BatchPayload[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    sentPayloads = [];

    globalThis.fetch = mock(async (_url: any, init: any) => {
      sentPayloads.push(JSON.parse(init.body));
      return new Response("OK", { status: 200 });
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const client = () =>
    AlitycsServer.init({ apiKey: "test-key", flushSize: 100 });

  test("init() requires apiKey", () => {
    expect(() => AlitycsServer.init({ apiKey: "" })).toThrow(
      "apiKey is required",
    );
    expect(() => AlitycsServer.init({ apiKey: "  " })).toThrow(
      "apiKey is required",
    );
  });

  test("every call requires userId or anonymousId", async () => {
    const sdk = client();

    expect(() => sdk.track({}, "signup_completed")).toThrow(
      "requires userId or anonymousId",
    );
    expect(() =>
      sdk.track({ userId: "  ", anonymousId: "   " }, "signup_completed"),
    ).toThrow("requires userId or anonymousId");

    // Blank ids are trimmed before validation — whitespace-only identity is absent.
    expect(() => sdk.alias({}, "")).toThrow("non-blank previousId");

    await sdk.shutdown();
  });

  test("track() stamps the per-call identity and drains by default", async () => {
    const sdk = client();

    await sdk.track({ anonymousId: "anon_1" }, "page_viewed", {
      path: "/pricing",
    });

    expect(sentPayloads.length).toBe(1);
    const event = sentPayloads[0].events[0];
    expect(event.event).toBe("page_viewed");
    expect(event.eventType).toBe("track");
    expect(event.anonymousId).toBe("anon_1");
    expect(event.userId).toBeUndefined();
    expect(event.sessionId).toBe("");
    expect(sentPayloads[0].events[0].properties.path).toBe("/pricing");

    await sdk.shutdown();
  });

  test("user-only identity sends no anonymous id", async () => {
    const sdk = client();

    await sdk.track({ userId: "usr_9" }, "invoice_paid");

    expect(sentPayloads[0].events[0].userId).toBe("usr_9");
    expect(sentPayloads[0].events[0].anonymousId).toBe("");

    await sdk.shutdown();
  });

  test("interleaved calls on one shared client never leak identity", async () => {
    const sdk = client();

    // Two overlapping requests sharing one process-wide client.
    const first = sdk.track({ anonymousId: "anon_A" }, "checkout_started", {
      step: "1",
    });
    const second = sdk.track({ userId: "usr_B" }, "checkout_started", {
      step: "1",
    });
    await Promise.all([first, second]);

    const events = sentPayloads.flatMap((payload) => payload.events);
    expect(events.length).toBe(2);
    const byAnon = events.filter((event) => event.anonymousId === "anon_A");
    const byUser = events.filter((event) => event.userId === "usr_B");
    expect(byAnon.length).toBe(1);
    expect(byUser.length).toBe(1);
    expect(byUser[0].anonymousId).toBe("");

    await sdk.shutdown();
  });

  test("alias/set/setOnce/unset emit reserved identify-type events", async () => {
    const sdk = client();

    await sdk.alias({ userId: "usr_1" }, "anon_legacy");
    await sdk.set({ userId: "usr_1" }, { plan: "pro", seats: 3 });
    await sdk.setOnce({ userId: "usr_1" }, { source: "adwords" });
    await sdk.unset({ userId: "usr_1" }, ["plan"]);

    const events = sentPayloads.flatMap((payload) => payload.events);
    expect(events[0]).toMatchObject({
      event: "$alias",
      eventType: "identify",
      properties: { previousId: "anon_legacy" },
    });
    expect(events[1]).toMatchObject({
      event: "$set",
      properties: { plan: "pro", seats: "3" },
    });
    expect(events[2]).toMatchObject({
      event: "$set_once",
      properties: { source: "adwords" },
    });
    expect(events[3]).toMatchObject({
      event: "$unset",
      properties: { $keys: '["plan"]' },
    });

    await sdk.shutdown();
  });

  test("unset filters blank keys and rejects when nothing remains", async () => {
    const sdk = client();

    expect(() => sdk.unset({ userId: "u" }, [])).toThrow(
      "at least one non-blank key",
    );
    expect(() => sdk.unset({ userId: "u" }, ["", "   "])).toThrow(
      "at least one non-blank key",
    );
    expect(() =>
      sdk.unset(
        { userId: "u" },
        Array.from({ length: 51 }, (_, i) => `k${i}`),
      ),
    ).toThrow("at most 50 keys");

    // Non-string entries are ignored rather than serialized.
    await sdk.unset({ userId: "u" }, ["plan", 42 as unknown as string]);
    expect(sentPayloads[0].events[0].properties.$keys).toBe('["plan"]');

    await sdk.unset({ userId: "u" }, ["plan", "", "seats"]);
    expect(sentPayloads[1].events[0].properties.$keys).toBe('["plan","seats"]');

    await sdk.shutdown();
  });

  test("trait operations fail fast on oversized input", async () => {
    const sdk = client();

    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 51; i++) tooMany[`trait_${i}`] = i;
    expect(() => sdk.set({ userId: "u" }, tooMany)).toThrow(
      "At most 50 traits",
    );

    expect(sentPayloads.length).toBe(0);
    await sdk.shutdown();
  });

  test("dedupeKey collapses repeated calls inside the window", async () => {
    const sdk = client();

    await Promise.all([
      sdk.track({ anonymousId: "a" }, "webhook_received", undefined, {
        dedupeKey: "wh_123",
      }),
      sdk.track({ anonymousId: "a" }, "webhook_received", undefined, {
        dedupeKey: "wh_123",
      }),
    ]);

    const events = sentPayloads.flatMap((payload) => payload.events);
    expect(events.length).toBe(1);

    await sdk.shutdown();
  });

  test("a buffered duplicate reports the still-pending original", async () => {
    const sdk = AlitycsServer.init({
      apiKey: "test-key",
      drainPerCall: false,
    });

    await sdk.track({ anonymousId: "a" }, "webhook_received", undefined, {
      dedupeKey: "wh_buffered",
    });
    const duplicate = await sdk.track(
      { anonymousId: "a" },
      "webhook_received",
      undefined,
      { dedupeKey: "wh_buffered" },
    );

    expect(duplicate).toEqual({ status: "partial", delivered: 0, pending: 1 });
    await sdk.shutdown();
  });

  test("drainPerCall:false buffers until an explicit flush", async () => {
    const sdk = AlitycsServer.init({ apiKey: "test-key", drainPerCall: false });

    await sdk.track({ anonymousId: "a" }, "queued_one");
    await sdk.track({ anonymousId: "b" }, "queued_two");
    expect(sentPayloads.length).toBe(0);
    expect(sdk.pending).toBe(2);

    await sdk.flush();
    expect(sentPayloads.flatMap((payload) => payload.events).length).toBe(2);

    await sdk.shutdown();
  });

  test("rejects non-positive batching settings", () => {
    expect(() =>
      AlitycsServer.init({ apiKey: "test-key", maxQueueSize: 0 }),
    ).toThrow("must be positive numbers");
  });

  test("drainPerCall drains concurrent calls as one delivery sequence", async () => {
    const sdk = client();
    const results = await Promise.all([
      sdk.track({ anonymousId: "a" }, "concurrent_one"),
      sdk.track({ anonymousId: "b" }, "concurrent_two"),
    ]);

    expect(results.every((result) => result.status === "drained")).toBe(true);
    expect(sentPayloads.flatMap((payload) => payload.events)).toHaveLength(2);
    await sdk.shutdown();
  });

  test("drainPerCall throws AlitycsDeliveryError when a non-persisted delivery pauses", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: "try later", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    ) as any;
    const sdk = AlitycsServer.init({ apiKey: "test-key", maxRetries: 0 });

    const failure = sdk.track({ anonymousId: "a" }, "must_deliver");
    await expect(failure).rejects.toBeInstanceOf(AlitycsDeliveryError);
    await expect(failure).rejects.toMatchObject({
      result: { status: "paused", pending: 1 },
    });

    await sdk.shutdown();
  });

  test("persistence makes a paused per-call result observable without throwing", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: "try later", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    ) as any;
    const storage = new MemoryEventStorage();
    const sdk = AlitycsServer.init({
      apiKey: "test-key",
      maxRetries: 0,
      persistence: { storage },
    });

    const result = await sdk.track({ anonymousId: "a" }, "persist_me");
    expect(result.status).toBe("paused");
    expect(result.pending).toBe(1);
    expect(
      storage.getItem(
        eventStorageKey("https://api.alitycs.com/events", "test-key"),
      ),
    ).toContain("persist_me");
    expect(sdk.stats().pausedUntil).toBeGreaterThan(Date.now());

    await sdk.shutdown();
  });

  test("typed monthly quota responses are treated as already accepted", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error: "Monthly event quota exceeded",
          code: "monthly_event_quota_exceeded",
          resetAt: "2026-09-01T00:00:00Z",
        },
        { status: 429 },
      ),
    ) as any;
    const sdk = client();

    const result = await sdk.track({ anonymousId: "a" }, "already_ingested");
    expect(result).toEqual({ status: "drained", delivered: 0, pending: 0 });
    expect(sdk.stats()).toMatchObject({
      acceptedQuotaExceeded: 1,
      rateLimited: 0,
    });
    expect(sentPayloads).toHaveLength(0);
    await sdk.shutdown();
  });

  test("trackRevenue emits the trusted revenue payload", async () => {
    const sdk = client();

    await sdk.trackRevenue(
      { anonymousId: "a" },
      {
        version: 1,
        kind: "transaction",
        factId: "order_1",
        amount: "19.99",
        currency: "USD",
      },
      { source: "checkout" },
    );

    expect(sentPayloads[0].events[0]).toMatchObject({
      event: "revenue_transaction",
      revenue: {
        version: 1,
        kind: "transaction",
        factId: "order_1",
        amount: "19.99",
        currency: "USD",
      },
    });
    await sdk.shutdown();
  });

  test("a shut-down client refuses new work", async () => {
    const sdk = client();
    await sdk.shutdown();

    expect(sdk.isShutdown).toBe(true);
    expect(() => sdk.track({ userId: "u" }, "late_event")).toThrow("shut down");
  });
});
