# @alitycs/nextjs

Next.js bindings for [Alitycs](https://alitycs.com). Two entries:

- **`@alitycs/nextjs`** (client) — the [`@alitycs/react`](../react) provider plus
  automatic route-change page views for **both** routers: App Router
  (`usePathname()` + `useSearchParams()`) and Pages Router (`router.events`).
- **`@alitycs/nextjs/server`** — server-side tracking for route handlers, server
  actions, and middleware, wrapping [`@alitycs/core`](../core).

## Install

```bash
bun add @alitycs/nextjs
```

`next >= 14` and `react >= 18` are peer dependencies.

## Client

```tsx
// app/layout.tsx (App Router) or pages/_app.tsx (Pages Router)
import { AlitycsProvider } from '@alitycs/nextjs';

<AlitycsProvider apiKey={process.env.NEXT_PUBLIC_ALITYCS_KEY!}>{children}</AlitycsProvider>
```

That is the whole integration: a `page` event fires on first render and on every
route change, with the resolved URL in `properties` and `context` (UTM parameters
parsed). All hooks from `@alitycs/react` are re-exported.

Options:

| Prop | Default | |
| --- | --- | --- |
| `trackPageViews` | `true` | Set `false` to fire page views yourself (`useAlitycsPageView`). |
| `router` | `'auto'` | The Pages Router is detected by its `#__next` mount point; set `'app'` or `'pages'` to skip detection. |
| `pageViewProperties` | — | Extra properties merged into every automatic page view. |

The tracker renders no DOM and never suspends your tree: `useSearchParams()` is
called inside a Suspense boundary that lives in this package, so consumer pages
keep static rendering and production builds do not hit the
"should be wrapped in a suspense boundary" de-opt.

## Server

```ts
// app/api/orders/route.ts
import { alitycs } from '@alitycs/nextjs/server';

export async function POST(request: Request) {
  const userId = await authenticate(request);
  await alitycs.track('order_placed', { total: 96.4 }, { userId });
  return Response.json({ ok: true });
}
```

Configuration is read once at first use:

```bash
ALITYCS_API_KEY=sk_live_...   # secret key (server-side only)
# ALITYCS_ENDPOINT overrides https://api.alitycs.com/events when self-hosting
```

or explicitly, before the first event:

```ts
import { configureAlitycs } from '@alitycs/nextjs/server';

configureAlitycs({ apiKey: process.env.ALITYCS_API_KEY!, flushSize: 10 });
```

- Every emitting call (`track`, `identify`, `captureError`, `page`,
  `trackRevenue`) drains the queue before its promise resolves — nothing is
  stranded when a serverless invocation freezes. `await alitycs.shutdown()` at
  the end of an invocation discards the client; the next call re-initialises.
- `options.userId` attaches one event to a user without leaking that identity
  into anything else the shared client emits. `alitycs.identify(userId)` sets it
  persistently instead.
- Initialisation and validation errors throw synchronously at the call site.
- The `/server` entry's import graph never touches `@alitycs/browser`; it is
  safe in Server Components and middleware.

Not offered by design: feature flags, session recording, group analytics, log
ingestion — Alitycs does not have these products.

## Development

```bash
bun test --coverage   # gate: lines >= 0.90, functions >= 0.85
bun run type-check
bun run lint
bun run build:all
```
