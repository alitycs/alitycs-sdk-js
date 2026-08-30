# @alitycs/react

React bindings for [`@alitycs/browser`](../browser). A thin binding and nothing
more — the client is the real `BrowserAlitycs`, so once initialised everything
(track, identify, page, captureError, flush…) matches the browser SDK exactly.

## Install

```bash
bun add @alitycs/react @alitycs/browser
```

`react >= 18` is a peer dependency (works on 19).

## Usage

```tsx
import { AlitycsProvider } from '@alitycs/react';

<AlitycsProvider apiKey="pk_live_..." config={{ autoCapture: true }}>
  <App />
</AlitycsProvider>
```

```tsx
import { useAlitycs, useTrack, useAlitycsPageView } from '@alitycs/react';

function Checkout() {
  const alitycs = useAlitycs();   // BrowserAlitycs | null (null during SSR)
  const track = useTrack();       // stable identity — safe in useEffect deps

  useAlitycsPageView(pathname);   // opt-in page view on route change

  return <button onClick={() => track('checkout_started', { cartValue: 96.4 })}>Pay</button>;
}
```

The full capability surface lives on the client returned by `useAlitycs()`:
`track`, `identify`, `reset`, `page`, `captureError`, `setGlobalProperties`,
`flush`, `shutdown`.

## Behaviour

- **Constructed once.** The client is created in a lazy state initialiser on
  the first render of the provider — never per render. Changing `apiKey` or
  `config` after mount has no effect; remount the provider (React `key`) to
  re-initialise.
- **SSR safe.** No `window`/`document`/`navigator` access at module scope or
  during render. On the server nothing is constructed and children render
  unchanged; hydration produces identical output. The instance exists from the
  first client render, so children can use it in their own mount effects.
- **Teardown.** Unmounting the provider calls `shutdown()`, which drains every
  queued event — SPA teardown does not strand events.

Not offered by design: feature flags, session recording, group analytics, log
ingestion.
