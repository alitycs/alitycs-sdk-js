# Alitycs JavaScript SDKs

[![CI](https://github.com/alitycs/alitycs-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/alitycs/alitycs-sdk-js/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official open-source JavaScript and TypeScript SDKs for sending product-analytics events to
[Alitycs](https://alitycs.com). This repository is a Bun workspace containing the universal SDK,
the browser SDK, and the lightweight browser loader.

## Packages

| Package                                            | Runtime                           | What it provides                                                                                                    |
| -------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`@alitycs/core`](sdks/core)                       | Node.js, Bun, Deno, edge runtimes | Tracking, identity, page and error events, trusted revenue events, batching, sessions, retry, and lifecycle control |
| [`@alitycs/browser`](sdks/browser)                 | Browsers                          | Core capabilities plus optional DOM/page autocapture, lifecycle flushing, and a GA4 compatibility bridge            |
| [`@alitycs/browser-snippet`](sdks/browser-snippet) | Browser script tag                | A small loader that queues calls and loads the browser SDK asynchronously                                           |

All packages are currently version `1.0.0`. Versioned, installable package archives are attached to
[GitHub Releases](https://github.com/alitycs/alitycs-sdk-js/releases). Public npm publication is
prepared by the release process but is not advertised until the `@alitycs` npm packages exist.

## Quick start

### Server and universal runtimes

```ts
import { Alitycs } from "@alitycs/core";

const analytics = Alitycs.init({
  apiKey: process.env.ALITYCS_API_KEY!,
});

analytics.identify("usr_123", { plan: "pro" });
analytics.track("signup_completed", { source: "docs" });
analytics.captureError("checkout_failed", { provider: "stripe" });

await analytics.shutdown();
```

Revenue ingestion is server-only and requires a secret key with the `revenue:write` scope:

```ts
analytics.trackRevenue({
  version: 1,
  kind: "transaction",
  factId: "order_123",
  amount: "19.99",
  currency: "USD",
});
```

### Browser

```ts
import { init } from "@alitycs/browser";

const analytics = init({
  apiKey: "pk_live_replace_me",
  autoCapture: true,
});

analytics.track("cta_clicked", { placement: "hero" });
```

SDK batches are sent to `https://api.alitycs.com/events` by default with
`Authorization: Bearer <apiKey>`. Browser integrations should use a publishable key. The SDK does
not call the tenant-scoped analytics read API.

## Supported surface

- `track`, `identify`, `reset`, `page`, and `captureError`
- `setGlobalProperties`, `removeGlobalProperties`, and `clearGlobalProperties`
- `flush` and `shutdown`
- Trusted `trackRevenue` on server runtimes
- Configurable batching, bounded queues, sessions, and retry
- Browser autocapture and GA4 command translation

The canonical payload contract is [event schema v0.4.0](specs/event-schema.json). See the
[API reference](docs/API.md) and individual package READMEs for details.

## Development

Requirements: [Bun](https://bun.sh) `1.3.14`.

```bash
bun install --frozen-lockfile
bun run typecheck:all
bun run lint:all
bun run format:check
bun run test:all
bun run build:all
```

Coverage is enforced per package at 90% lines and 85% functions. Pull requests run the same checks
on GitHub Actions.

## Releases

Pushing an annotated `vMAJOR.MINOR.PATCH` tag runs the release workflow. It verifies every package
version matches the tag, runs the complete test and build suite, creates attested package tarballs
with SHA-256 checksums, and publishes a GitHub Release. See [Releasing](docs/RELEASING.md).

## Community and security

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)

Security reports should use GitHub's private vulnerability reporting rather than a public issue.

## Related repository

- [Alitycs JVM SDK](https://github.com/alitycs/alitycs-sdk-jvm)

## License

[MIT](LICENSE) © 2026 Alitycs Team.
