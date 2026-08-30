# @alitycs/browser

The Alitycs browser SDK provides event tracking, page tracking, optional DOM auto-capture, and an opt-in GA4 compatibility bridge.

## Installation

```bash
bun add @alitycs/browser
# or: npm install @alitycs/browser
```

For archive-based installation, install both `alitycs-core-1.0.3.tgz` and
`alitycs-browser-1.0.3.tgz` from the matching
[GitHub Release](https://github.com/alitycs/alitycs-sdk-js/releases). Browser applications must use
a publishable key; never embed a secret API key in client code.

## Traffic page collection

Browser auto-capture is opt-in:

```ts
import { init } from '@alitycs/browser';

const analytics = init({
  apiKey: 'pk_live_replace_me',
  autoCapture: true,
});
```

With `autoCapture: true`, the SDK emits one canonical `eventType: 'page'` event for the initial document and one for each `pushState`, `replaceState`, or `popstate` navigation. Each page event includes the full URL, hostname, path, title, and referrer; its context includes `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, and `utm_term`. A custom `page('Pricing')` name still has `eventType: 'page'`.

Queued events use a bounded `fetch(..., { keepalive: true })` flush on `pagehide` and when the document becomes hidden. The publishable API key remains in the `Authorization` header. Call `shutdown()` only when permanently disposing the SDK; ordinary back/forward-cache navigation does not tear down auto-capture state.

### Delivery reliability and lifecycle

The browser inherits core's `FlushResult`, `stats()`, diagnostics, overflow policy, and opt-in WAL
configuration. `persistence: true` uses `localStorage`; a custom synchronous `EventStorage` can be
provided for another browser store. Pending batches keep their original `batchId`, `sentAt`, and
event membership across retries and reloads, while `Retry-After` pauses are restored until their
full server-directed deadline.

Exit handling calls `saveNow()` before a keepalive attempt. It is dirty-aware: a second exit event
after new events were accepted is flushed even when the first exit was recent. `pageshow` with
`persisted: true` re-arms delivery after bfcache restoration, and `shutdown()` removes all lifecycle
listeners.

`flush()` and `shutdown()` resolve to `FlushResult`; a `paused` result reports `pausedUntil`, and a
`partial` result reports the retained pending count. Inspect permanent rejections with
`quarantinedEvents()` and delivery counters with `stats()`.

## GA4 compatibility bridge

The bridge observes the standard `dataLayer` used by `gtag.js` and Google Tag Manager, translates GA4 analytics commands to Alitycs, and leaves application call sites unchanged.

### Self-hosted setup

Host `dist/ga4.min.js` on your own origin or CDN. Mirror mode is the default: it sends translated
events to Alitycs while leaving Google Analytics behavior intact:

```html
<script
  async
  src="/assets/alitycs/ga4.min.js"
  data-api-key="pk_live_replace_me"
  data-ga4-mode="mirror"
></script>
```

Use replace mode when Alitycs should be the analytics destination:

```html
<script
  async
  src="/assets/alitycs/ga4.min.js"
  data-api-key="pk_live_replace_me"
  data-ga4-mode="replace"
></script>
```

The standalone bundle exposes:

- `window.alitycs`: callable Alitycs API
- `window.AlitycsSDK`: the `BrowserAlitycs` instance
- `window.AlitycsGA4`: the installed bridge handle

Replace mode creates `window.gtag` when it is absent. If existing application code can call `gtag()` before the async bridge loads, keep the usual queue bootstrap:

```html
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    dataLayer.push(arguments);
  }
</script>
```

Supported script attributes:

| Attribute             | Default                          | Purpose                                              |
| --------------------- | -------------------------------- | ---------------------------------------------------- |
| `data-api-key`        | required                         | Alitycs API key                                      |
| `data-endpoint`       | `https://api.alitycs.com/events` | Custom ingestion endpoint                            |
| `data-debug`          | `false`                          | Bridge and SDK diagnostics                           |
| `data-ga4-mode`       | `mirror`                         | `mirror` or `replace`                                |
| `data-ga4-data-layer` | `dataLayer`                      | Custom data-layer name                               |
| `data-ga4-pageviews`  | `true`                           | Set to `false` to disable bridge-generated pageviews |

### Package setup

```ts
import { BrowserAlitycs } from '@alitycs/browser';
import { installGa4Bridge } from '@alitycs/browser/ga4';

const sdk = BrowserAlitycs.init({ apiKey: 'pk_live_replace_me' });
const bridge = installGa4Bridge(sdk, {
  mode: 'mirror',
  capturePageViews: true,
});

bridge.getStats();
bridge.uninstall();
```

Installing the bridge twice on the same data layer returns the original handle. `uninstall()` restores the bridge-owned `dataLayer.push`, History API methods, listeners, and replace-mode `gtag` shim.

### Translation behavior

- Existing data-layer entries are processed once in FIFO order; future `push()` calls keep their native return value.
- `gtag('event', name, params)` becomes `sdk.track(name, params)` with the exact GA event name.
- `page_view` becomes `sdk.page('page_view', params)`. Initial and SPA pageviews are deduplicated by URL for one second.
- Global `set`, per-measurement `config`, and persistent object-state parameters are merged with event parameters taking precedence.
- `user_id` calls `identify()` once per distinct value.
- Multiple GA destinations produce one Alitycs event. Google Ads/Floodlight-only destinations are ignored.
- `js`, `consent`, `get`, and internal `gtm.*` commands do not create analytics events.
- In replace mode, `event_callback` runs asynchronously once after the command is accepted. `get` returns locally cached values when available.

Each translated event includes `alitycs_integration=ga4`, `ga4_bridge_mode`, and, when available, `ga4_target_id`. The bridge accepts up to 46 GA parameters so its metadata remains within the ingestion limit of 50 properties. Invalid, oversized, and excess parameters are dropped; `getStats().droppedInvalid` reports the number of dropped parameters.

### Consent

Analytics storage is allowed until a GA consent command explicitly denies it. While `analytics_storage` is `denied`, analytics events and identity calls are dropped and are not buffered. A later grant does not replay them; when pageview capture is enabled, the bridge emits the current page once.

### Mirror versus replace

Mirror mode is the migration-safe choice: Google continues handling the original data-layer command, including its callbacks, while Alitycs records a translated copy.

Replace mode changes only the data destination used by code calling `gtag()` or `dataLayer.push()`. It does not block a Google script that is still loaded and does not disable GA tags inside GTM. Remove the Google loader or disable those tags to avoid continuing to send data to Google. In debug mode the bridge warns when it detects an active Google loader or tag manager.

The bridge intentionally does not reproduce GA Enhanced Measurement beyond pageviews, import historical GA data, synthesize Google client/session identifiers, or provide a GTM community template.

## License

[MIT](LICENSE)
