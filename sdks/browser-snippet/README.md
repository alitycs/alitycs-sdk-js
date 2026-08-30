# `@alitycs/browser-snippet`

A small, dependency-free browser loader for Alitycs. It installs a temporary `window.alitycs`
function, queues calls made before the full browser SDK is ready, and replays them after loading.

## Installation

Build from source:

```bash
bun install --frozen-lockfile
bun run build
```

The generated files are `dist/snippet.js` and `dist/snippet.min.js`. Versioned archives are also
attached to [GitHub Releases](https://github.com/alitycs/alitycs-sdk-js/releases).

Host `snippet.min.js` on your site or CDN, then include it with a publishable API key:

```html
<script src="/assets/alitycs/snippet.min.js" data-api-key="pk_live_replace_me" data-auto-capture="true" async></script>
```

The loader's default full-SDK URL is pinned at build time to the released browser version:
`https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.3/dist/browser.min.js`. Set
`data-sdk-url` when self-hosting the browser bundle.

## Usage

Calls are safe immediately, even before the full SDK has loaded:

```html
<script>
  alitycs('identify', 'usr_123', { plan: 'pro' });
  alitycs('track', 'signup_completed', { source: 'docs' });
  alitycs('page', 'Pricing');
  alitycs('captureError', 'checkout_failed', { provider: 'stripe' });
</script>
```

Method helpers are chainable:

```js
alitycs.track('cta_clicked', { placement: 'hero' }).page('Checkout');
```

## Configuration

| Attribute           | Default                                        | Description                                                     |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| `data-api-key`      | required                                       | Publishable Alitycs key                                         |
| `data-sdk-url`      | Build-pinned `@alitycs/browser` jsDelivr URL   | Full browser SDK URL; override it when self-hosting             |
| `data-endpoint`     | `https://api.alitycs.com/events`               | Custom worker ingestion endpoint                                |
| `data-auto-track`   | `true`                                         | Queue the initial page event                                    |
| `data-auto-capture` | `false`                                        | Capture the initial page and SPA navigations in the browser SDK |
| `data-debug`        | `false`                                        | Enable loader diagnostics                                       |

The snippet never calls `/v1/*`; those routes belong to the authenticated analytics read API.

## Loading behavior

1. Parse the current script's `data-*` configuration.
2. Preserve any calls buffered by an inline bootstrap.
3. Install the queueing stub and optionally enqueue the initial page event.
4. Load the full browser SDK immediately when calls are queued, or lazily on interaction/idle.
5. Replay queued calls once and replace the stub with the real browser API.

## Development

```bash
bun run type-check
bun run lint
bun run format:check
bun test
bun run build
```

The bundle-size test enforces the compressed size budget, and coverage is gated at 90% lines and
85% functions.

## License

[MIT](LICENSE)
