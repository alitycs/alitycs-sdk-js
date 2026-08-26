# @alitycs/server

Stateless server-side analytics SDK for Node and Bun. Every call carries its own
identity, so one shared client can safely serve interleaved requests — nothing is
stored between calls, and no `identify()` can ever re-attribute another request's
events.

## Install

```bash
bun add @alitycs/server   # or npm/pnpm/yarn — depends on @alitycs/core
```

## Usage

```ts
import { AlitycsServer } from '@alitycs/server';

const analytics = AlitycsServer.init({ apiKey: process.env.ALITYCS_SECRET_KEY! });

// In a request handler — identity comes from the request, not from client state:
await analytics.track(
  { userId: session.userId, anonymousId: cookies.get('aid') },
  'checkout_completed',
  { orderId: 'ord_1' }
);

await analytics.set({ userId: session.userId }, { plan: 'pro' });
await analytics.setOnce({ userId: session.userId }, { signupSource: 'referral' });
await analytics.alias({ userId: session.userId }, anonymousIdFromCookie);
await analytics.unset({ userId: session.userId }, ['trial_end']);
```

### Identity rules

- Every call requires `userId` **or** `anonymousId` (both allowed). Missing ids throw.
- Events are stamped only from the call's `CallIdentity`; concurrent requests on a
  shared client cannot inherit each other's identity.
- `sessionId` is always empty server-side — there is no ambient browser session.

### Delivery semantics

- Calls validate fail-fast and throw synchronously on invalid input (blank names,
  missing identity, more than 50 traits) instead of silently dropping events.
- Batching, retry with backoff, and poison-batch bisection are inherited from
  `@alitycs/core`. By default every emitting call drains the queue before its promise
  resolves (`drainPerCall: true`), so a crash right after `await` loses nothing.
  Long-lived workers can pass `drainPerCall: false` and flush on their own cadence.

### Reserved events

`alias`, `set`, `setOnce`, and `unset` travel as `eventType: 'identify'` events named
`$alias`, `$set`, `$set_once`, and `$unset`. The analytics layer links anonymous
histories to users automatically for any event carrying both ids — including plain
`identify()` calls — so `$alias` is only needed when the previous identity was itself
a stable user or device id that should merge into the current one.

> Supersedes the per-request identity scoping previously improvised in
> `@alitycs/nextjs/server`, which reached into core's private state. New server
> integrations should prefer this package.
