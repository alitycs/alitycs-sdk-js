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
bun add https://github.com/alitycs/alitycs-sdk-js/releases/download/v1.0.2/alitycs-core-1.0.2.tgz
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
| `maxRetries`     | `3`                              | Retry attempts for retryable transport failures                                    |
| `sessionTimeout` | `1800000`                        | Inactivity timeout in milliseconds                                                 |
| `batching`       | `true`                           | Send queued batches or one event per request                                       |
| `debug`          | `false`                          | Enable SDK diagnostics                                                             |

Requests use `Authorization: Bearer <apiKey>` and `Content-Type: application/json`. Event payloads
conform to [schema v0.4.0](../../specs/event-schema.json).

## API surface

- `track(eventName, properties?, options?)`
- `trackRevenue(payload, properties?)`
- `identify(userId, traits?, options?)`
- `reset()`
- `page(name?, properties?, options?)`
- `captureError(errorName, properties?, options?)`
- `setGlobalProperties`, `getGlobalProperties`, `removeGlobalProperties`, `clearGlobalProperties`
- `flush()` and `shutdown()`
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
