# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible changes are recorded
here before a version tag is created.

## [1.0.2] - 2026-08-28

### Changed
- @alitycs/browser-snippet: default CDN target replaced with a build-injected,
  exact-version npm CDN URL (`https://cdn.jsdelivr.net/npm/@alitycs/browser@<version>/dist/browser.min.js`);
  self-hosting via `data-sdk-url` remains supported.
- First public npm publication of @alitycs/core, @alitycs/browser, and
  @alitycs/browser-snippet at 1.0.2.

### Fixed
- @alitycs/browser-snippet now ships `dist/snippet.d.ts` (the manifest declared it;
  no build produced it).
- @alitycs/core no longer loses events when `flush()` races an in-flight background send; flush
  now waits for the exact delivery generation it observed and reports incomplete delivery.

## [1.0.1] - 2026-08-23

- Replaced the non-cryptographic UUID fallback with Web Crypto and fail closed when secure
  randomness is unavailable.

## [1.0.0] - 2026-08-23

- Initial public source release of `@alitycs/core`, `@alitycs/browser`, and
  `@alitycs/browser-snippet`.
- Added the v0.4.0 event contract, retry-safe batching, session reset, global properties, error and
  revenue events, browser lifecycle flushing, optional autocapture, and the GA4 bridge.
- Enforced 90% line and 85% function coverage gates.

[1.0.2]: https://github.com/alitycs/alitycs-sdk-js/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/alitycs/alitycs-sdk-js/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/alitycs/alitycs-sdk-js/releases/tag/v1.0.0
