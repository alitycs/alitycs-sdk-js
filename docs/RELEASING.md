# Releasing

The repository uses one version for `@alitycs/core`, `@alitycs/browser`, and
`@alitycs/browser-snippet`.

1. Update all three package versions and the changelog in a pull request.
2. Run `bun run check` from the repository root.
3. Merge the release pull request to `main`.
4. Create and push an annotated tag on the merged `main` commit matching the full package version:
   `vMAJOR.MINOR.PATCH` for a stable release or `vMAJOR.MINOR.PATCH-PRERELEASE` for a prerelease.
   For example, use `v1.1.0` or `v1.1.0-rc.1`. Tags whose commit is not reachable from remote
   `main` are rejected.
5. The `Release` workflow verifies and builds each package in a read-only job, then a separate
   minimal-permission job attests and attaches installable tarballs with SHA-256 checksums and
   creates the GitHub Release with generated notes.

Public npm publication is intentionally not attempted until the organization configures the npm
namespace and a trusted publisher or `NPM_TOKEN`. Once configured, registry publication must run
only after the same version and test gates and should use npm provenance.
