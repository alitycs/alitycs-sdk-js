# Releasing

The repository uses one version for `@alitycs/core`, `@alitycs/browser`, and
`@alitycs/browser-snippet`.

1. Update all three package versions and the changelog in a pull request.
2. Run `bun run check` from the repository root.
3. Merge the release pull request to `main`.
4. Create and push an annotated tag matching the package version, for example `v1.1.0`.
5. The `Release` workflow verifies the tag, builds each package, attests and attaches installable
   tarballs with SHA-256 checksums, and creates the GitHub Release with generated notes.

Public npm publication is intentionally not attempted until the organization configures the npm
namespace and a trusted publisher or `NPM_TOKEN`. Once configured, registry publication must run
only after the same version and test gates and should use npm provenance.
