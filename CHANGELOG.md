# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible changes are recorded
here before a version tag is created.

## [1.0.3] - 2026-08-30

### Fixed
- The clean-install release gate now disables Corepack's parent workspace package-manager check
  for the isolated pnpm fixture, so the reviewed archives are verified under npm, pnpm, Yarn,
  and Bun in GitHub Actions.

### Changed
- First public npm publication of @alitycs/core, @alitycs/browser, and
  @alitycs/browser-snippet moves to 1.0.3 after the immutable 1.0.2 release tag failed before
  artifact creation.

## [1.0.2] - 2026-08-28

### Changed
- @alitycs/browser-snippet: default CDN target replaced with a build-injected,
  exact-version npm CDN URL (`https://cdn.jsdelivr.net/npm/@alitycs/browser@<version>/dist/browser.min.js`);
  self-hosting via `data-sdk-url` remains supported.
- Prepared the first public npm publication of @alitycs/core, @alitycs/browser, and
  @alitycs/browser-snippet.

### Fixed
- @alitycs/browser-snippet now ships `dist/snippet.d.ts` (the manifest declared it;
  no build produced it).
- @alitycs/core no longer loses events when `flush()` races an in-flight background send; flush
  now waits for the exact delivery generation it observed and reports incomplete delivery.
- @alitycs/core keeps its public `UTM_KEYS` export, clears the active flush slot when every event
  exceeds a page-exit payload bound, and waits for keepalive replay sends during shutdown.
- @alitycs/core reports SDK version 1.0.2, prioritizes unresolved events in bounded page-exit
  replays, and omits empty UTM parameters; snippet builds reject malformed semantic versions while
  retaining exact prerelease and build-metadata support.

### Added

- `@alitycs/core`: identity-linking and person-trait surface — `alias(previousId)` emits a
  reserved `$alias` identify-type event, `set()` / `setOnce()` emit `$set` / `$set_once`
  (latest-wins and first-wins person traits), and `unset(keys)` emits `$unset` with the key list
  encoded as JSON in `$keys`. Event construction moved to a shared `buildAnalyticsEvent` module so
  all surfaces emit identical wire shapes.
- `@alitycs/server` (new package): stateless server-side analytics for Node/Bun. Every call
  requires explicit `userId` and/or `anonymousId`, nothing is stored between calls, and validation
  fails fast instead of silently dropping events — a shared client can safely serve interleaved
  requests. Batching/retry/bisection are reused from core; calls drain by default
  (`drainPerCall: false` opts out).
- `specs/event-schema.json` 0.5.0: documents the reserved identify-type event names and their
  property encodings.

### Changed

- `@alitycs/core`, `@alitycs/browser`, and `@alitycs/server`: delivery now has an opt-in append-log
  WAL, stable batch replay, bounded queue overflow policies, structured diagnostics, delivery
  stats, and bounded permanent-failure quarantine. `flush()` and `shutdown()` return observable
  `FlushResult` values; stalled persisted state is retained instead of being silently discarded.
- Retryable 429 responses now honor the complete server-directed `Retry-After` deadline in bounded
  sleep slices and restore that pause after reload. The worker's typed
  `monthly_event_quota_exceeded` response acknowledges already-ingested events without replaying
  them; known `413` responses join adaptive batch isolation.
- Browser exit delivery saves the WAL before keepalive flushing, retries when the queue became dirty
  after an earlier exit notification, re-arms after bfcache restoration, and removes lifecycle
  listeners during shutdown.

- Analytics backend resolves anonymous histories into users at query time via tenant-scoped
  identity links; funnels now credit pre-signup anonymous steps to the identifying user, retention
  cohorts include linked anonymous activity, and metrics expose `unique_actors`. Dashboards rank
  identified visitors above anonymous ones (`DASHBOARD_TAXONOMY_VERSION` `2026-08-26.1`).

- `@alitycs/browser-snippet`: the default full-SDK URL is now derived from the directory that
  served the snippet itself (via `document.currentScript` first, then script-tag scanning) instead
  of pointing at the nonexistent `cdn.alitycs.com` host. The last-resort fallback is same-origin
  `/alitycs/browser.min.js`; explicit `data-sdk-url` still wins.
- `@alitycs/core`: init now rejects degenerate batching configuration (`flushSize`, `maxQueueSize`,
  or `flushInterval` below 1) with an error instead of silently dropping every event.
- `@alitycs/browser`: queued snippet calls replay only onto the public API surface (`track`,
  `captureError`, `identify`, `reset`, `page`, and the global-properties methods); unknown method
  names are warned about and skipped instead of being invoked off the SDK instance.
- `@alitycs/browser`: auto-captured `$click` hrefs are capped at 500 characters, `mailto:` targets
  are dropped, and query parameters whose key is `email` or whose value looks like an email address
  are stripped before the event leaves the page.
- `@alitycs/core`: dedupe-window eviction prefers expired entries over oldest-inserted live ones,
  so overflow no longer evicts keys that are still actively deduplicating.
- Page-exit delivery semantics (verified): a keepalive flush that fails before teardown requeues
  its undelivered events into the regular bounded queue for the next timer/size/manual flush, and
  the payload is capped at 60KB (`maxRetries: 0`, one attempt). Residual limitation: once the page
  is actually torn down there is no later flush, so events requeued during the final keepalive send
  are not delivered, and browsers may still truncate large keepalive bodies.

### Fixed

- `@alitycs/core`: an expired session's rotation now clears the identified `userId`. Post-rotation
  events previously kept stamping the pre-rotation user identity until the next `identify()`.
- `@alitycs/browser`: a single navigation now produces exactly one pageview when the GA4 bridge,
  autoCapture, or both are enabled. Auto-captured page views share the bridge's
  `ga4:page_view:<location>` dedupe key and window instead of emitting a parallel un-deduped event.
- `@alitycs/browser-snippet`: the published package declares `types: dist/snippet.d.ts`, and
  `build:prod` now emits the declarations alongside the bundle.
- `@alitycs/core`: `trackRevenue()` reports missing, non-string, blank, or oversized `factId`
  values as the revenue-contract error instead of crashing with a TypeError on `.trim()`.

- `@alitycs/core`: a 429 response's `Retry-After` header (delta-seconds or HTTP-date) is honored
  through its complete server-directed deadline; only individual sleep chunks are capped at 60s.
- `@alitycs/react`: `<AlitycsProvider>` is now StrictMode-safe. Clients are refcounted per
  `{ apiKey, ...config }` identity in a module-level registry: mounting joins (or constructs)
  the shared client, unmounting releases it, and shutdown runs only after the last consumer
  unmounts — deferred by one tick so React StrictMode's synchronous mount → unmount → mount
  cycle keeps the same live client instead of leaving behind a shut-down instance whose events
  accumulated and stalled. An instance shut down out-of-band is re-created rather than reused.
- `@alitycs/core`: `track()` no longer throws into host pages when a property value cannot be
  JSON-serialized (circular references, nested BigInt); such values become an
  `[unserializable]` placeholder string.
- `@alitycs/core`: delivery-loss warnings (rejected/dropped/delayed events) are always logged via
  `console.warn` instead of being gated behind `debug`.

### Added

- `@alitycs/core`: client-side event limits enforced at enqueue — at most 50 properties, property
  keys ≤100 chars, values ≤1000 chars, estimated event size ≤64KB, non-blank event name with a
  userId or anonymousId, and epoch-millisecond timestamps. Rejected events are counted on
  `sdk.droppedEvents` and logged.
- `@alitycs/core`: transport sends report their outcome (`ok`, HTTP status, transient) with a
  configurable per-request abort timeout (default 10s). BatchManager splits a batch in half when
  the server rejects it wholesale (HTTP 400), requeues undelivered events at the queue head after
  transient failures, and bounds shutdown draining instead of looping on persistent failure.

- Replaced the non-cryptographic UUID fallback with Web Crypto and fail closed when secure
  randomness is unavailable.

## [1.0.0] - 2026-08-23

- Initial public source release of `@alitycs/core`, `@alitycs/browser`, and
  `@alitycs/browser-snippet`.
- Added the v0.4.0 event contract, retry-safe batching, session reset, global properties, error and
  revenue events, browser lifecycle flushing, optional autocapture, and the GA4 bridge.
- Enforced 90% line and 85% function coverage gates.

[1.0.3]: https://github.com/alitycs/alitycs-sdk-js/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/alitycs/alitycs-sdk-js/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/alitycs/alitycs-sdk-js/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/alitycs/alitycs-sdk-js/releases/tag/v1.0.0
