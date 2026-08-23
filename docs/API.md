# Alitycs SDK API Documentation

## Installation

```bash
npm install @alitycs/core
# or
bun add @alitycs/core
```

Until the first npm publication, use the package archives attached to
[GitHub Releases](https://github.com/alitycs/alitycs-sdk-js/releases).

## Quick Start

```typescript
import {
  captureError,
  init,
  track,
  identify,
  page,
  setGlobalProperties,
  shutdown,
} from "@alitycs/core";

const analytics = init({ apiKey: "your-api-key" });

identify("user-123", { plan: "premium" });
track("button_clicked", { buttonId: "signup" });
captureError("checkout_failed", { provider: "stripe" });
page("Dashboard");

// On app teardown
await shutdown();
```

### Class-based usage

```typescript
import { Alitycs } from "@alitycs/core";

const analytics = Alitycs.init({
  apiKey: "your-api-key",
  endpoint: "https://api.alitycs.com/events",
  debug: true,
});

analytics.track("signup", { method: "google" });
analytics.captureError("checkout_failed", { provider: "stripe" });
await analytics.flush();
await analytics.shutdown();
```

## Configuration

### AlitycsConfig

| Property         | Type      | Required | Default                            | Description                                                       |
| ---------------- | --------- | -------- | ---------------------------------- | ----------------------------------------------------------------- |
| `apiKey`         | `string`  | Yes      | —                                  | Authentication key for API access                                 |
| `endpoint`       | `string`  | No       | `'https://api.alitycs.com/events'` | API endpoint URL                                                  |
| `flushInterval`  | `number`  | No       | `10000`                            | Batch flush interval in milliseconds                              |
| `flushSize`      | `number`  | No       | `25`                               | Number of events that triggers an automatic flush                 |
| `maxQueueSize`   | `number`  | No       | `1000`                             | Maximum events in the batch queue                                 |
| `maxRetries`     | `number`  | No       | `3`                                | Maximum retry attempts for failed HTTP requests                   |
| `debug`          | `boolean` | No       | `false`                            | Enable debug logging                                              |
| `sessionTimeout` | `number`  | No       | `1800000` (30 min)                 | Session inactivity timeout in milliseconds                        |
| `batching`       | `boolean` | No       | `true`                             | Enable event batching (when `false`, events are sent immediately) |

## Alitycs Class

### `static init(config: AlitycsConfig): Alitycs`

Creates and returns a new `Alitycs` instance. This is the only way to create an instance — the
constructor is protected for the browser SDK subclass.

**Throws:** `Error` — `"apiKey is required"` if `apiKey` is missing or empty.

```typescript
const analytics = Alitycs.init({ apiKey: "your-api-key" });
```

### `track(eventName: string, properties?: Record<string, unknown>): void`

Track a custom event. No-ops if `eventName` is falsy.

```typescript
analytics.track("button_clicked", {
  buttonId: "signup",
  page: "landing",
});
```

### `captureError(errorName: string, properties?: Record<string, unknown>): void`

Track an explicit error event for error-rate analytics. No-ops if `errorName` is falsy.

```typescript
analytics.captureError("checkout_failed", {
  provider: "stripe",
  retryable: true,
});
```

### `identify(userId: string, traits?: Record<string, unknown>): void`

Associate subsequent events with a user ID and set optional user traits. No-ops if `userId` is falsy. Sets the user ID on the current session.

```typescript
analytics.identify("user-123", {
  email: "user@example.com",
  plan: "premium",
});
```

### `reset(): void`

Clears the identified user and rotates both the anonymous and session IDs. Global properties are
not cleared.

```typescript
analytics.reset();
```

### `trackRevenue(payload: RevenuePayload, properties?: Record<string, unknown>): void`

Sends an explicit trusted revenue payload. This operation is for server runtimes only and requires
a secret key with the `revenue:write` scope.

```typescript
analytics.trackRevenue({
  version: 1,
  kind: "transaction",
  factId: "order_123",
  amount: "19.99",
  currency: "USD",
});
```

### `page(name?: string, properties?: Record<string, unknown>): void`

Track a page view. Defaults to `'page_view'` if `name` is not provided. Automatically includes `title` from the browser environment. The `url` and `referrer` are captured in `context` (via `collectContext()`).

```typescript
analytics.page("Dashboard", { section: "analytics" });
```

### `setGlobalProperties(properties: Record<string, unknown>): void`

Set properties that will be merged into every subsequent event. Calling multiple times accumulates properties. Event-specific properties override globals with the same key.

```typescript
analytics.setGlobalProperties({ appVersion: "1.2.0", env: "production" });
```

### `getGlobalProperties(): Record<string, unknown>`

Returns a shallow copy of the current global properties.

```typescript
const globals = analytics.getGlobalProperties();
```

### `removeGlobalProperties(keys: string[]): void`

Remove specific global properties by key.

```typescript
analytics.removeGlobalProperties(["env", "debugMode"]);
```

### `clearGlobalProperties(): void`

Remove all global properties.

```typescript
analytics.clearGlobalProperties();
```

### `flush(): Promise<void>`

Flush all pending events immediately. When batching is enabled, flushes the batch queue. When batching is disabled, waits for all in-flight requests to complete.

```typescript
await analytics.flush();
```

### `shutdown(): Promise<void>`

Gracefully shuts down the core SDK, stops its batch timer, and flushes remaining events. The browser
SDK override also stops autocapture and removes lifecycle listeners.

```typescript
await analytics.shutdown();
```

### `pending: number` (getter)

Returns the number of events waiting to be sent. When batching is enabled, returns the batch queue size. When batching is disabled, returns the number of in-flight requests.

```typescript
console.log(analytics.pending); // 3
```

## Module-Level Convenience API

The SDK exports module-level functions that manage a default instance. These are useful when you only need a single SDK instance.

```typescript
import {
  captureError,
  init,
  track,
  identify,
  page,
  flush,
  shutdown,
} from "@alitycs/core";
```

### `init(config: AlitycsConfig): Alitycs`

Creates the default instance via `Alitycs.init()` and returns it.

### `track(eventName: string, properties?: Record<string, unknown>): void`

Calls `track()` on the default instance. No-ops if `init()` has not been called.

### `captureError(errorName: string, properties?: Record<string, unknown>): void`

Calls `captureError()` on the default instance. No-ops if `init()` has not been called.

### `identify(userId: string, traits?: Record<string, unknown>): void`

Calls `identify()` on the default instance. No-ops if `init()` has not been called.

### `page(name?: string, properties?: Record<string, unknown>): void`

Calls `page()` on the default instance. No-ops if `init()` has not been called.

### `flush(): Promise<void>`

Calls `flush()` on the default instance.

### `shutdown(): Promise<void>`

Calls `shutdown()` on the default instance and clears the reference.

### `setGlobalProperties(properties: Record<string, unknown>): void`

Calls `setGlobalProperties()` on the default instance. No-ops if `init()` has not been called.

### `getGlobalProperties(): Record<string, unknown>`

Returns global properties from the default instance, or `{}` if `init()` has not been called.

### `removeGlobalProperties(keys: string[]): void`

Calls `removeGlobalProperties()` on the default instance. No-ops if `init()` has not been called.

### `clearGlobalProperties(): void`

Calls `clearGlobalProperties()` on the default instance. No-ops if `init()` has not been called.

## Event Types

### EventType

```typescript
type EventType = "track" | "identify" | "page" | "error";
```

### AnalyticsEvent

Every call to `track()`, `captureError()`, `identify()`, or `page()` produces an `AnalyticsEvent`:

```typescript
interface AnalyticsEvent {
  eventId: string; // e.g. "evt_abc123"
  event: string; // Event name
  eventType: EventType; // "track" | "identify" | "page" | "error"
  userId?: string; // Set after identify()
  anonymousId: string; // e.g. "anon_xyz789", persists across sessions
  sessionId: string; // e.g. "sess_def456", rotates on timeout
  timestamp: number; // Date.now() at enqueue time
  properties: Record<string, string>; // Serialized event properties
  context: EventContext; // Automatically collected context
}
```

### EventContext

Collected automatically on every event by `collectContext()`:

```typescript
interface EventContext {
  sdkVersion: string; // e.g. "1.0.0"
  sdkLanguage: string; // "typescript"
  locale?: string; // navigator.language or Intl locale
  timezone?: string; // Intl timezone (e.g. "America/New_York")
  userAgent?: string; // navigator.userAgent
  url?: string; // window.location.href
  referrer?: string; // document.referrer
  screen?: Record<string, string>; // { width, height }
  utmSource?: string; // from ?utm_source=
  utmMedium?: string; // from ?utm_medium=
  utmCampaign?: string; // from ?utm_campaign=
  utmContent?: string; // from ?utm_content=
  utmTerm?: string; // from ?utm_term=
}
```

### BatchPayload

Events are sent to the server wrapped in a `BatchPayload`:

```typescript
interface BatchPayload {
  batchId: string; // e.g. "batch_abc123"
  sentAt: number; // Date.now() at send time
  events: AnalyticsEvent[];
}
```

## Global Properties

Global properties are key-value pairs that are automatically merged into every event. They persist for the lifetime of the SDK instance (in-memory only). Event-specific properties override global properties with the same key.

```typescript
const analytics = Alitycs.init({ apiKey: "your-api-key" });

// Set global properties
analytics.setGlobalProperties({ appVersion: "1.2.0", env: "production" });

// This event will include appVersion and env
analytics.track("button_clicked", { buttonId: "signup" });
// → properties: { appVersion: "1.2.0", env: "production", buttonId: "signup" }

// Event properties override globals
analytics.track("button_clicked", { env: "staging" });
// → properties: { appVersion: "1.2.0", env: "staging" }
```

## Batching

When `batching: true` (default), events are queued in a `BatchManager`:

- Events are flushed automatically when the queue reaches `flushSize` (default 25).
- A timer flushes every `flushInterval` ms (default 10,000ms).
- The queue is capped at `maxQueueSize` (default 1,000).
- Call `flush()` to send immediately.

When `batching: false`, each event is wrapped in its own `BatchPayload` and sent immediately via `HttpTransport`. In-flight requests are tracked and awaited on `flush()` or `shutdown()`.

## Session Management

The SDK uses a `SessionManager` to maintain session and anonymous IDs:

- **Session ID** (`sess_*`): Rotates when the session exceeds `sessionTimeout` (default 30 minutes of inactivity).
- **Anonymous ID** (`anon_*`): Generated once and preserved across session rotations.
- **User ID**: Set via `identify()`, attached to the current session.
- Sessions are persisted to `localStorage` (under `alitycs_session`) when available. If `localStorage` is unavailable (e.g., Node.js or disabled), sessions are in-memory only.
- On restore, expired sessions create a new session ID but keep the existing anonymous ID.

## Browser autocapture

Autocapture is available from `@alitycs/browser`, not `@alitycs/core`:

```typescript
import { init } from "@alitycs/browser";

const analytics = init({
  apiKey: "pk_live_replace_me",
  autoCapture: true,
});
```

When `autoCapture: true`, the SDK automatically captures:

### `$click` events

Captured on clicks to interactive elements (`<a>`, `<button>`, `<input>`, `<select>`, `<textarea>`, `<label>`, and elements with `role="button"`, `role="link"`, or `role="menuitem"`).

Properties: `tag`, `id`, `classes`, `text` (truncated to 100 chars), `href`.

### Page events

Captured through the canonical `page()` API on the initial document and once per `pushState`, `replaceState`, and `popstate` navigation. The default event name is `page_view`, and its event type remains `page` even when callers supply a custom page name.

Properties: `url`, `hostname`, `path`, `title`, `referrer`. The event context also preserves the full URL (including click IDs) and all five UTM values.

When the page is hidden or receives `pagehide`, queued events are sent in one bounded `fetch` request with `keepalive: true`. The API key remains in the `Authorization` header, and this lifecycle flush does not retry.

## Transport

`HttpTransport` sends `BatchPayload` to the configured `endpoint` via HTTP POST with:

- `Authorization: Bearer <apiKey>` header
- `Content-Type: application/json` header
- Automatic retries up to `maxRetries` (default 3) with exponential backoff

## Error Handling

- `Alitycs.init()` throws `"apiKey is required"` if the API key is missing or empty.
- `track()`, `captureError()`, `identify()`, and `page()` silently no-op on invalid input (empty event name, empty error name, empty user ID).
- Auto-capture errors are caught internally and never propagate to the host page.
- Transport failures are retried automatically; after `maxRetries`, the event is dropped.

## Exported Types

```typescript
export type {
  AlitycsConfig,
  ResolvedConfig,
  AnalyticsEvent,
  EventType,
  EventContext,
  BatchPayload,
  SessionData,
} from "./types";
```
