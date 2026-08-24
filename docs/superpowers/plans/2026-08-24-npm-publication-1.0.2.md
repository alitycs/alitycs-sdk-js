# SDK 1.0.2 Publication Plan (alitycs-sdk-js)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]` syntax for tracking.

**Goal:** Publish `@alitycs/core`, `@alitycs/browser`, and `@alitycs/browser-snippet` as **1.0.2** to npm: replace browser-snippet's nonexistent `cdn.alitycs.com` default with a build-injected, exact-version jsdelivr URL (self-hosting still supported), fix the snippet package's never-built `.d.ts`, verify the three packages install together under clean npm/pnpm/yarn/Bun fixtures, and prepare the release workflow for environment-gated OIDC publishing after a one-time bootstrap.

**Architecture:** Versioning stays manual-and-locked (`scripts/check-release-version.ts` requires all three manifests to equal the tag), so 1.0.2 is one coordinated bump. The CDN URL becomes a build-time constant derived from the released version and injected with `bun build --define`; source keeps an identical fallback so tests and un-injected builds behave the same. The existing `release.yml` keeps producing tarballs + provenance attestations; an npm publish job is added behind a protected GitHub environment so it activates only when maintainers flip it on after the bootstrap.

**Tech Stack:** Bun 1.3.14 workspaces, `bun build` + `--define`, `tsc` for declarations, `bun:test`, GitHub Actions (pinned SHAs), npm trusted publishing / OIDC.

**Repo:** `/Volumes/External/alitycs/alitycs-sdk/alitycs-sdk-js` (dual remotes; releases gate on `github.repository == 'alitycs/alitycs-sdk-js'`).

**Branch:** `chore/release-1.0.2`. Note: the checkout is currently on `phase-0/flush-fix` with an unmerged flush fix — land or rebase onto `main` first, then cut this branch.

---

### Task 1: Coordinated 1.0.2 version bump

**Files:**
- Modify: `package.json` (root, private — bump for tidiness)
- Modify: `sdks/core/package.json`
- Modify: `sdks/browser/package.json`
- Modify: `sdks/browser-snippet/package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump versions**

Set `"version": "1.0.2"` in all four manifests (root included). In each of the three publishable packages confirm unchanged: `"license": "MIT"`, `repository.directory`, `publishConfig { "access": "public", "provenance": true }`.

- [ ] **Step 2: Update CHANGELOG.md**

Replace the `[Unreleased]` heading content with:

```markdown
## [1.0.2] - 2026-08-31

### Changed
- @alitycs/browser-snippet: default CDN target replaced with a build-injected,
  exact-version npm CDN URL (`https://cdn.jsdelivr.net/npm/@alitycs/browser@<version>/dist/browser.min.js`);
  self-hosting via `data-sdk-url` remains supported.
- First public npm publication of @alitycs/core, @alitycs/browser, and
  @alitycs/browser-snippet at 1.0.2.

### Fixed
- @alitycs/browser-snippet now ships `dist/snippet.d.ts` (the manifest declared it;
  no build produced it).
```

Keep the existing compare-link footer style used by the file (add a `[1.0.2]: …/compare/v1.0.1…v1.0.2` link if prior versions have one).

- [ ] **Step 3: Verify the version gate accepts the tag**

```bash
bun run check
git tag v1.0.2   # local only for verification; do not push yet
bun run scripts/check-release-version.ts v1.0.2
```

Expected: exits 0 ("all package versions match"). Delete nothing — the tag stays local until publication day (Task 6).

- [ ] **Step 4: Commit**

```bash
git add package.json sdks/core/package.json sdks/browser/package.json sdks/browser-snippet/package.json CHANGELOG.md
git commit -m "chore: coordinate 1.0.2 release across core, browser, browser-snippet"
```

---

### Task 2: Build-injected exact-version CDN URL in browser-snippet

**Files:**
- Modify: `sdks/browser-snippet/src/config.ts` (line ~10 `DEFAULT_SDK_URL`)
- Modify: `sdks/browser-snippet/src/loader.ts` (line ~130 duplicated fallback)
- Modify: `sdks/browser-snippet/src/types.ts` or a new `src/build-constants.d.ts` (ambient declaration)
- Modify: `sdks/browser-snippet/package.json` (`build:dev`, `build:prod`)
- Create: `scripts/build-snippet-with-cdn.ts` (derives URL from the browser package version)
- Test: modify assertions in `tests/config.test.ts` (~lines 154, 185), `tests/edge-cases.test.ts` (~line 98); add `tests/cdn-default.test.ts`

- [ ] **Step 1: Update the test expectations first**

In `tests/config.test.ts` and `tests/edge-cases.test.ts`, replace every expectation of `'https://cdn.alitycs.com/sdk@2/browser.min.js'` with the new constant import:

```ts
import { DEFAULT_SDK_URL } from "../src/config";
// ...
expect(resolved.sdkUrl).toBe(DEFAULT_SDK_URL);
expect(DEFAULT_SDK_URL).toBe(
  "https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.2/dist/browser.min.js",
);
```

(If the tests assert via string literals rather than imports, swap the literal strings; keep exactly one place — the new `tests/cdn-default.test.ts` below — that pins the full URL.)

```bash
bun test sdks/browser-snippet/tests/config.test.ts sdks/browser-snippet/tests/edge-cases.test.ts
```

Expected: FAIL — source still returns the old URL.

- [ ] **Step 2: Inject the constant in source**

Create `sdks/browser-snippet/src/build-constants.ts`:

```ts
/**
 * Build-time injected exact-version CDN URL for @alitycs/browser.
 * scripts/build-snippet-with-cdn.ts derives it from sdks/browser/package.json and passes
 * bun build --define __ALITYCS_BROWSER_CDN_URL__. The literal below is the identical
 * fallback so plain `bun test` / un-injected builds resolve the same value.
 */
declare const __ALITYCS_BROWSER_CDN_URL__: string | undefined;

export const BROWSER_VERSION = "1.0.2";

export const DEFAULT_SDK_URL: string =
  typeof __ALITYCS_BROWSER_CDN_URL__ === "string"
    ? __ALITYCS_BROWSER_CDN_URL__
    : `https://cdn.jsdelivr.net/npm/@alitycs/browser@${BROWSER_VERSION}/dist/browser.min.js`;
```

Note on `typeof` safety: after `--define` replacement this compiles to comparing against the injected string literal (always taken branch); without define, `typeof` on an undeclared identifier is legal JS returning `"undefined"` — both paths are safe at runtime.

In `src/config.ts`: replace

```ts
const DEFAULT_SDK_URL = 'https://cdn.alitycs.com/sdk@2/browser.min.js';
```

with

```ts
import { DEFAULT_SDK_URL } from './build-constants';
```

and re-export it for tests (`export { DEFAULT_SDK_URL };` — keep any existing export shape).

In `src/loader.ts` line ~130 replace the hardcoded string:

```ts
script.src = this.config.sdkUrl || DEFAULT_SDK_URL;
```

with the import added to the file's header. Grep for any other occurrence:

```bash
grep -rn "cdn.alitycs.com/sdk@2" sdks/browser-snippet/src sdks/browser-snippet/tests
```

Expected: zero hits in `src/`.

- [ ] **Step 3: The build script**

Create `scripts/build-snippet-with-cdn.ts` at repo root:

```ts
/**
 * Builds @alitycs/browser-snippet with the CDN URL injected from the current
 * @alitycs/browser version, keeping source and artifact in lockstep.
 */
import { $ } from "bun";

const browserPkg = await Bun.file(new URL("../sdks/browser/package.json", import.meta.url)).json();
const version: string = browserPkg.version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`Unexpected @alitycs/browser version: ${version}`);
}
const cdnUrl = `https://cdn.jsdelivr.net/npm/@alitycs/browser@${version}/dist/browser.min.js`;

const define = `__ALITYCS_BROWSER_CDN_URL__:'${cdnUrl}'`;

await $`bun build sdks/browser-snippet/src/snippet.ts --outfile=sdks/browser-snippet/dist/snippet.js --target=browser --format=iife --sourcemap=inline --define ${define}`;
await $`bun build sdks/browser-snippet/src/snippet.ts --outfile=sdks/browser-snippet/dist/snippet.min.js --target=browser --format=iife --minify --define ${define}`;

console.log(`Built snippet with CDN default: ${cdnUrl}`);
```

Wire it into `sdks/browser-snippet/package.json` (replacing the raw `bun build` calls inside `build:dev`/`build:prod`):

```json
"build": "bun run build:dev && bun run build:prod",
"build:dev": "cd ../.. && bun run scripts/build-snippet-with-cdn.ts",
"build:prod": "cd ../.. && bun run scripts/build-snippet-with-cdn.ts",
```

Simpler and clearer: make `build` call the script once (it emits both outputs) and keep `build:watch` as-is for dev iteration:

```json
"build": "cd ../.. && bun run scripts/build-snippet-with-cdn.ts",
```

- [ ] **Step 4: Pin-the-artifact test**

Create `sdks/browser-snippet/tests/cdn-default.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { DEFAULT_SDK_URL } from "../src/config";

describe("CDN default", () => {
  test("is an exact-version npm CDN URL, never a floating range", () => {
    expect(DEFAULT_SDK_URL).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@alitycs\/browser@\d+\.\d+\.\d+\/dist\/browser\.min\.js$/,
    );
    expect(DEFAULT_SDK_URL).not.toContain("@latest");
    expect(DEFAULT_SDK_URL).not.toContain("sdk@");
  });
});
```

- [ ] **Step 5: Run snippet suite and verify the artifact**

```bash
bun run build:snippet
grep -o "https://cdn.jsdelivr.net/npm/@alitycs/browser@[0-9.]*" sdks/browser-snippet/dist/snippet.min.js
bun run test:snippet
```

Expected: grep prints the 1.0.2 URL (proving injection); all snippet tests PASS including size budget (`tests/size.test.ts` ≤5120 bytes — the longer URL adds ~30 bytes; if the size test fails, update its budget with a comment noting the pinned URL).

Also update stale doc/example references found earlier:
- `sdks/browser-snippet/README.md` line ~24 (usage example)
- `sdks/browser-snippet/examples/custom-config.html` lines ~11, ~143
- `sdks/browser/README.md` lines ~45,56 reference `sdk@2/ga4.min.js` — leave GA4 references alone (out of scope) but note them in the PR description.

- [ ] **Step 6: Commit**

```bash
git add sdks/browser-snippet scripts/build-snippet-with-cdn.ts
git commit -m "feat(snippet): inject exact-version npm CDN URL at build time"
```

---

### Task 3: Ship the missing `snippet.d.ts`

**Files:**
- Create: `sdks/browser-snippet/tsconfig.build.json`
- Modify: `sdks/browser-snippet/package.json` (add `build:types`, include in `build`)
- Verify: `dist/snippet.d.ts` exists after build and matches `main`/`types` fields

- [ ] **Step 1: Add the types build**

Create `sdks/browser-snippet/tsconfig.build.json` (mirror the sibling package's file — copy `sdks/core/tsconfig.build.json` and adjust `include`):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist"
  },
  "include": ["src/snippet.ts"]
}
```

Add to `sdks/browser-snippet/package.json` scripts:

```json
"build:types": "tsc -p tsconfig.build.json",
```

and make `build` run it too:

```json
"build": "cd ../.. && bun run scripts/build-snippet-with-cdn.ts && cd sdks/browser-snippet && bun run build:types",
```

- [ ] **Step 2: Verify emission and consumer resolution**

```bash
bun run build:snippet
ls -la sdks/browser-snippet/dist/snippet.d.ts
echo 'import type {} from "@alitycs/browser-snippet";' > /tmp/type-check.ts
bunx tsc --noEmit --strict --moduleResolution bundler /tmp/type-check.ts --paths '{"@alitycs/browser-snippet":["'$(pwd)'/sdks/browser-snippet"]}'
```

Expected: `.d.ts` exists; tsc resolves types without error. (If the one-liner path-mapping proves fiddly, instead run the Task 4 fixture smoke which exercises real installs.)

- [ ] **Step 3: Commit**

```bash
git add sdks/browser-snippet/tsconfig.build.json sdks/browser-snippet/package.json sdks/browser-snippet/dist/snippet.d.ts
git commit -m "fix(snippet): emit dist/snippet.d.ts declared by the package manifest"
```

Note: `dist/` is gitignored; committing the built declaration is intentionally avoided — drop the dist path from the command if git refuses, and rely on CI building before pack.

---

### Task 4: Cross-package-manager install fixtures

**Files:**
- Create: `tests/install-fixtures/smoke/package.json`
- Create: `tests/install-fixtures/smoke/index.mjs`
- Create: `tests/install-fixtures/run.sh`
- Modify: root `package.json` script `check` chain (append `bun run tests/install-fixtures/run.sh` as `verify:installs`)

- [ ] **Step 1: The smoke fixture**

`tests/install-fixtures/smoke/package.json`:

```json
{
  "name": "alitycs-install-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@alitycs/browser": "file:../../../release/@alitycs-browser-1.0.2.tgz",
    "@alitycs/browser-snippet": "file:../../../release/@alitycs-browser-snippet-1.0.2.tgz",
    "@alitycs/core": "file:../../../release/@alitycs-core-1.0.2.tgz"
  }
}
```

`tests/install-fixtures/smoke/index.mjs`:

```js
import { init } from "@alitycs/browser";

const instance = init({
  apiKey: "pk_smoke_test_0000000000000000000000000000",
  endpoint: "https://api.example.test/events",
});
if (typeof instance.shutdown !== "function") {
  throw new Error("@alitycs/browser did not initialize");
}
await instance.shutdown();

const snippetSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(
    new URL(
      "../../../release/@alitycs-browser-snippet-1.0.2/package/dist/snippet.min.js",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (!snippetSource.includes("cdn.jsdelivr.net/npm/@alitycs/browser@1.0.2")) {
  throw new Error("Snippet bundle lost its pinned CDN URL");
}
console.log("install smoke OK");
```

(The snippet tarball path inspection is a convenience; the load-bearing assertion is that all three tarballs install and `init` runs. Adjust the unpacked-path detail to however the runner extracts tarballs.)

- [ ] **Step 2: The runner**

`tests/install-fixtures/run.sh`:

```bash
#!/usr/bin/env bash
# Pack the three packages and prove they install together under each PM.
set -euo pipefail
root="$(pwd)"
out="$root/release"
mkdir -p "$out"

(cd sdks/core && bun pm pack --outdir "$out")
(cd sdks/browser && bun pm pack --outdir "$out")
(cd sdks/browser-snippet && bun pm pack --outdir "$out")

fixture="$root/tests/install-fixtures/smoke"
rm -rf "$fixture/node_modules" "$fixture/bun.lock*"

run_pm() {
  local pm="$1"
  echo "== $pm =="
  rm -rf "$fixture/node_modules"
  case "$pm" in
    npm)   (cd "$fixture" && npm install --no-audit --no-fund) ;;
    pnpm)  (cd "$fixture" && pnpm install --no-frozen-lockfile) ;;
    yarn)  (cd "$fixture" && yarn install --ignore-engines) ;;
    bun)   (cd "$fixture" && bun install) ;;
  esac
  node "$fixture/index.mjs"
}

for pm in npm pnpm yarn bun; do
  command -v "$pm" >/dev/null || { echo "skip $pm (not installed)"; continue; }
  run_pm "$pm"
done
echo "All available package managers resolved the three @alitycs packages."
```

Add to root `package.json` scripts:

```json
"verify:installs": "bash tests/install-fixtures/run.sh",
```

- [ ] **Step 3: Run it**

```bash
chmod +x tests/install-fixtures/run.sh
bun run verify:installs
```

Expected: per-PM sections each ending `install smoke OK`. If Yarn 1 chokes on `file:` tarballs of scoped packages, switch that fixture entry to `npm pack`-produced tarball URLs and note it in the PR.

- [ ] **Step 4: Commit**

```bash
git add tests/install-fixtures package.json
git commit -m "test: verify core+browser+browser-snippet install together across npm/pnpm/yarn/bun"
```

---

### Task 5: Environment-gated npm publishing workflow + bootstrap runbook

**Files:**
- Modify: `.github/workflows/release.yml` (add publish job)
- Create: `docs/PUBLISHING.md`

- [ ] **Step 1: Add the publish job**

Append to `.github/workflows/release.yml` (keep the existing job untouched; pin action SHAs to the same commits already pinned elsewhere in the repo's workflows):

```yaml
  publish-npm:
    # Enabled only once docs/PUBLISHING.md bootstrap has run and the "npm-publish"
    # GitHub environment is configured with protection rules. Until then this job
    # must stay disabled.
    if: github.repository == 'alitycs/alitycs-sdk-js' && vars.NPM_PUBLISH_ENABLED == 'true'
    needs: release
    runs-on: ubuntu-latest
    environment: npm-publish
    permissions:
      id-token: write   # OIDC for npm trusted publishing
      contents: read
    steps:
      - uses: actions/checkout@<same-pin-as-existing-checkout>
      - uses: oven-sh/setup-bun@<pin>
        with:
          bun-version-file: .bun-version
      - uses: actions/setup-node@<pin>
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - name: Install and build
        run: |
          bun install --frozen-lockfile
          bun run check
          bun run build:all
      - name: Publish (OIDC trusted publishing, npm >= 11.5.1)
        run: |
          npm install -g npm@latest
          for pkg in core browser browser-snippet; do
            (cd "sdks/$pkg" && npm publish --access public --provenance)
          done
```

Notes:
- Trusted publishing requires npm 11.5.1+ and Node 24 — hence the explicit setup-node 24 + `npm@latest`.
- The `vars.NPM_PUBLISH_ENABLED == 'true'` gate keeps the job dormant until the environment + trusted publishers exist (you cannot configure a trusted publisher for a package npm hasn't seen).
- Provenance also comes from the existing attest step; `--provenance` here generates npm's own provenance from OIDC.

- [ ] **Step 2: Write the bootstrap runbook**

Create `docs/PUBLISHING.md`:

```markdown
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
```

- [ ] **Step 3: Validate workflow syntax**

```bash
bunx yaml-lint .github/workflows/release.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"
```

Expected: parses cleanly.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml docs/PUBLISHING.md
git commit -m "ci: add environment-gated npm trusted publishing with bootstrap runbook"
```

---

### Task 6: Full gates + tag checklist

- [ ] **Step 1: Everything green**

```bash
bun run audit && bun run check && bun run verify:installs
```

Expected: clean end to end.

- [ ] **Step 2: Merge and tag (publication day, after production routes pass smoke)**

```bash
git push github chore/release-1.0.2 && git push origin chore/release-1.0.2
# after PR merge:
git push github v1.0.2 && git push origin v1.0.2
```

Then follow `docs/PUBLISHING.md` (bootstrap era first time). After publish completes, record the sha256 of the two wizard assets for the wizard plan:

```bash
shasum -a 256 sdks/browser/dist/browser.min.js sdks/browser-snippet/dist/snippet.min.js
```

Expected values get copied into `alitycs-wizard/src/static-assets/MANIFEST.sha256` (wizard plan, Task 1).

---

## Rollout notes for this repo

- Order per parent spec: auth service → web UI/BFF → production DNS/HTTPS smoke → **SDK 1.0.2 (this plan)** → wizard 0.1.0 → clean-machine npx smoke.
- After merge: `graphify update /Volumes/External/alitycs` then `graphify global add /Volumes/External/alitycs/graphify-out/graph.json --as alitycs`.
