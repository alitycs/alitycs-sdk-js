# `@alitycs/core`

Universal TypeScript SDK for sending product-analytics events to Alitycs from trusted server and
JavaScript runtimes. It provides batching, bounded queues, sessions, retry, global properties, and
explicit lifecycle control without browser-only autocapture.

## Installation

Install the package from npm:

```bash
bun add @alitycs/core
# or: npm install @alitycs/core
```

For archive-based installation, use the archive attached to the matching
[GitHub Release](https://github.com/alitycs/alitycs-sdk-js/releases):

```bash
bun add https://github.com/alitycs/alitycs-sdk-js/releases/download/v1.0.3/alitycs-core-1.0.3.tgz
```

## Usage

```ts
import { Alitycs } from '@alitycs/core';

const analytics = Alitycs.init({
  apiKey: process.env.ALITYCS_API_KEY!,
});

analytics.identify('usr_123', { plan: 'pro' });
analytics.track('button_clicked', { label: 'Start trial' });
analytics.page('Dashboard');
analytics.captureError('checkout_failed', { provider: 'stripe' });

await analytics.shutdown();
```

`reset()` clears the user identity and rotates both the anonymous and session IDs. Global
properties persist until they are explicitly removed or cleared:

```ts
analytics.setGlobalProperties({ appVersion: '1.4.0' });
analytics.track('feature_used', { feature: 'ask_data' });
analytics.reset();
```

### Identity linking and person traits

`alias()`, `set()`, `setOnce()`, and `unset()` manage identity merges and person profiles. They
travel as `eventType: 'identify'` events with reserved names (`$alias`, `$set`, `$set_once`,
`$unset`):

```ts
// Merge a previous (anonymous or user) id into the current identity.
analytics.alias('anon_legacy');

// Person traits: latest-wins ($set), first-wins ($set_once), removal ($unset).
analytics.set({ plan: 'pro', seats: 3 });
analytics.setOnce({ signupSource: 'referral' });
analytics.unset(['seats']);
```

The analytics layer links anonymous histories to users automatically for any event carrying both
ids — including plain `identify()` calls — so `alias()` is only needed when the previous identity
was itself a stable id that should merge into the current one. Trait maps follow the same limits as
event properties (at most 50 entries; oversized calls drop with a warning like any invalid event).

For shared Node/Bun servers, prefer [`@alitycs/server`](../server) — every call carries explicit
ids, so interleaved requests can never inherit each other's identity.

### Trusted revenue events

Revenue ingestion is server-only. Use a secret key with `revenue:write`; never expose that key in a
browser application.

```ts
analytics.trackRevenue({
  version: 1,
  kind: 'transaction',
  factId: 'order_123',
  amount: '19.99',
  currency: 'USD',
});
```

## Configuration

| Option           | Default                          | Description                                                                        |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `apiKey`         | required                         | Publishable key for ordinary ingest, or a secret key for trusted server operations |
| `endpoint`       | `https://api.alitycs.com/events` | Worker ingestion endpoint                                                          |
| `flushInterval`  | `10000`                          | Batch flush interval in milliseconds                                               |
| `flushSize`      | `25`                             | Queue size that triggers a flush                                                   |
| `maxQueueSize`   | `1000`                           | Maximum queued events                                                              |
| `maxRetries`     | `3`                              | Finite, non-negative integer retry count for retryable transport failures           |
| `requestTimeout` | `10000`                          | Per-request abort timeout in milliseconds                                          |
| `sessionTimeout` | `1800000`                        | Inactivity timeout in milliseconds                                                 |
| `batching`       | `true`                           | Send queued batches or one event per request                                       |
| `overflowPolicy` | `drop-newest`                   | Queue-full policy: `drop-newest` or `drop-oldest`                                 |
| `persistence`    | `false`                          | Opt-in WAL; `true` uses browser storage, or pass `PersistenceOptions`              |
| `onDiagnostics`  | —                               | Receives structured validation and delivery diagnostics                            |
| `debug`          | `false`                          | Enable SDK diagnostics                                                             |

Requests use `Authorization: Bearer <apiKey>` and `Content-Type: application/json`. Event payloads
conform to [schema v0.5.0](../../specs/event-schema.json).

`Retry-After` is honored without blocking an in-flight request indefinitely. Server-directed
deadlines are capped at five minutes, then persisted as a queue pause for durable clients.

## Delivery reliability

The queue is memory-backed by default. Set `persistence: true` in a browser, or provide a
synchronous `{ getItem, setItem, removeItem }` adapter, to enable the append-log WAL. Pending
batches are written before transport handoff and replayed with the same `batchId`, `sentAt`, and
event membership after an unknown outcome. The storage namespace is isolated by a short endpoint
and API-key fingerprint; a live foreign writer causes a safe memory-only companion mode.

`flush()` and `shutdown()` return:

```ts
type FlushResult = {
  status: 'drained' | 'partial' | 'paused';
  delivered: number;
  pending: number;
  pausedUntil?: number;
};
```

`Retry-After` is authoritative for a rate-limit pause, including after reload. A
`monthly_event_quota_exceeded` response is treated as already ingested and is not replayed. Whole
batch `400` and `413` responses are isolated by adaptive bisection; permanent failures are exposed
through `quarantinedEvents()`. Use `stats()` and `onDiagnostics` for counters, pause state,
overflow, storage contention, and delivery errors.

## API surface

- `track(eventName, properties?, options?)`
- `trackRevenue(payload, properties?)`
- `identify(userId, traits?, options?)`
- `reset()`
- `page(name?, properties?, options?)`
- `captureError(errorName, properties?, options?)`
- `setGlobalProperties`, `getGlobalProperties`, `removeGlobalProperties`, `clearGlobalProperties`
- `flush(options?)` and `shutdown()` return `FlushResult`
- `stats()` and `quarantinedEvents()`
- `pending`

The same surface is available through module-level convenience functions after `init()`.

## Development

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run format:check
bun test
bun run build:all
```

The committed test configuration enforces at least 90% line and 85% function coverage.

## License

[MIT](LICENSE)
