# Publishing @alitycs packages to npm

The `@alitycs` scope does not exist publicly until the first publish. Because npm can only
configure a trusted publisher for an existing package, publication happens in two eras.

## One-time bootstrap (token era)

1. Create a granular access token (Packages: Read and write; scope limited to `@alitycs`),
   with a short expiry (≤ 1 day). Do NOT store it in the repo.
2. Push the reviewed annotated tag and wait for the GitHub `Release` workflow to succeed. It builds,
   cross-installs, checksums, and attests normalized package tarballs; in particular, Bun pack
   converts the browser package's `workspace:*` dependency to the exact release version.
3. From a maintainer machine, download and verify those exact GitHub Release assets, then publish
   them in dependency order. Token-era bootstrap cannot emit npm OIDC provenance, so disable the
   package manifest's provenance setting explicitly for these three one-time commands:

   ```bash
   set -euo pipefail
   readonly release_tag="v1.0.2"
   readonly release_version="${release_tag#v}"
   rm -rf release
   mkdir release
   gh release download "$release_tag" --repo alitycs/alitycs-sdk-js --dir release
   (cd release && sha256sum --check SHA256SUMS)
   gh attestation verify release/*.tgz --repo alitycs/alitycs-sdk-js
   npm whoami
   export NPM_CONFIG_PROVENANCE=false
   npm publish "release/alitycs-core-${release_version}.tgz" --access public
   npm publish "release/alitycs-browser-${release_version}.tgz" --access public
   npm publish "release/alitycs-browser-snippet-${release_version}.tgz" --access public
   ```

   Authenticate only through the environment variable
   `NPM_CONFIG_//registry.npmjs.org/:_authToken`; never write the token to this repository.
4. Immediately after all three publishes succeed, configure GitHub Actions trusted publishers:
   npmjs.com → package settings → Connected GitHub Actions publisher →
   repository alitycs/alitycs-sdk-js, workflow release.yml, environment npm-publish.
   Repeat for all three packages.
5. For every package, enable npm's **Require two-factor authentication and disallow tokens**
   publishing restriction. Then revoke the bootstrap token and set repository variable
   `NPM_PUBLISH_ENABLED=true`.
6. Protect the npm-publish GitHub environment: required reviewers (maintainers),
   restrict deployment to the main branch + v* tags.

## Ongoing releases (OIDC era)

Tag v<version> → release.yml builds, cross-installs, and attests normalized tarballs; the
publish-npm job downloads those same artifacts, verifies their checksums, rechecks the immutable
tag immediately before each package, and publishes under the protected environment with OIDC
(Node 24.16.0, integrity-pinned npm 12.0.2). Token publishing is blocked by each package's npm
publishing restriction, not merely by the trusted-publisher connection.

## Verification before tagging

- bun run check
- bun run verify:installs   # clean installs across npm/pnpm/yarn/bun
- Confirm https://app.alitycs.com and https://api.alitycs.com/events pass their production
  smoke checks (rollout order requires production routes live BEFORE the wizard consumes these).
