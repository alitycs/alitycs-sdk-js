# Releasing

The repository uses one version for `@alitycs/core`, `@alitycs/browser`, and
`@alitycs/browser-snippet`.

1. Update all three package versions and the changelog in a pull request.
2. Run `bun run check` from the repository root.
3. Merge the release pull request to `main`.
4. Create and push an annotated tag on the merged `main` commit matching the full package version:
   `vMAJOR.MINOR.PATCH` for a stable release or `vMAJOR.MINOR.PATCH-PRERELEASE` for a prerelease.
   For example, use `v1.1.0` or `v1.1.0-rc.1`. Tags whose commit is not reachable from remote
   `main` are rejected. The active `Immutable release tags` repository ruleset prevents updates or
   deletion of `refs/tags/v*` without any bypass actor.
5. The `Release` workflow verifies and builds each package in a read-only job, then a separate
   minimal-permission job fetches and rechecks the annotated-tag identity before attesting and
   again immediately before attaching installable tarballs with SHA-256 checksums to the GitHub
   Release. The
   workflow intentionally has no Actions concurrency group because pull-request
   workflow code can reserve repository-global groups. Immutable tags, the fresh identity recheck,
   and immutable tag and version publication identities provide duplicate-release safety without
   that repository-global lock.

Public npm publication is intentionally not attempted until the organization configures the npm
namespace and a trusted publisher or `NPM_TOKEN`. Once configured, registry publication must run
only after the same version and test gates and should use npm provenance.
