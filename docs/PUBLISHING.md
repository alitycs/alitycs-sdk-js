# Publishing @alitycs packages to npm

The `@alitycs` scope does not exist publicly until the first publish. Because npm can only
configure a trusted publisher for an existing package, publication happens in two eras.

## One-time bootstrap (token era)

1. Create a granular access token (Packages: Read and write; scope limited to `@alitycs`),
   with a short expiry (≤ 1 day). Do NOT store it in the repo.
2. From a maintainer machine, against a clean checkout of the tagged release:
   npm whoami && for pkg in core browser browser-snippet; do
     (cd sdks/$pkg && npm publish --access public --provenance)
   done
   (Authenticate with the token via environment variable NPM_CONFIG_//registry.npmjs.org/:_authToken.)
3. Immediately after all three publishes succeed, configure GitHub Actions trusted publishers:
   npmjs.com → package settings → Connected GitHub Actions publisher →
   repository alitycs/alitycs-sdk-js, workflow release.yml, environment npm-publish.
   Repeat for all three packages.
4. Revoke the granular token. Set repo variable NPM_PUBLISH_ENABLED=true.
5. Protect the npm-publish GitHub environment: required reviewers (maintainers),
   restrict deployment to the main branch + v* tags.

## Ongoing releases (OIDC era)

Tag v<version> → release.yml builds, attests, drafts the GitHub Release; the publish-npm job
runs under the protected environment with OIDC (Node 24, npm ≥ 11.5.1). Token publishing is
disallowed by revoking the bootstrap token and by npm trusted-publisher policy.

## Verification before tagging

- bun run check
- bun run verify:installs   # clean installs across npm/pnpm/yarn/bun
- Confirm https://app.alitycs.com and https://api.alitycs.com/events pass their production
  smoke checks (rollout order requires production routes live BEFORE the wizard consumes these).
