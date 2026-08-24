#!/usr/bin/env bash
# Pack the three packages and prove they install together under each PM.
set -euo pipefail
root="$(pwd)"
out="$root/release"
fixture="$root/tests/install-fixtures/smoke"
fixture_pkg="$fixture/package.json"
mkdir -p "$out"

# Ensure dist artifacts exist and are current before packing.
bun run build:all

(cd sdks/core && bun pm pack --destination "$out")
(cd sdks/browser && bun pm pack --destination "$out")
(cd sdks/browser-snippet && bun pm pack --destination "$out")

# Unpack the snippet tarball so the smoke check can assert on its pinned CDN URL.
rm -rf "$out/@alitycs-browser-snippet-1.0.2"
mkdir -p "$out/@alitycs-browser-snippet-1.0.2"
tar -xzf "$out/alitycs-browser-snippet"-*.tgz -C "$out/@alitycs-browser-snippet-1.0.2"

rm -rf "$fixture/node_modules" "$fixture/bun.lock" "$fixture/bun.lockb" \
  "$fixture/package-lock.json" "$fixture/pnpm-lock.yaml" "$fixture/yarn.lock"

restore_manifest() {
  if [ -f "$fixture/package.json.orig" ]; then
    mv "$fixture/package.json.orig" "$fixture_pkg"
  fi
}
trap restore_manifest EXIT

run_pm() {
  local pm="$1"
  echo "== $pm =="
  rm -rf "$fixture/node_modules"
  case "$pm" in
    npm)   (cd "$fixture" && npm install --no-audit --no-fund --loglevel=error) ;;
    pnpm)  (cd "$fixture" && pnpm install --no-frozen-lockfile) ;;
    yarn)
      # Yarn 1 walks up to the repo root, adopts its non-yarn packageManager field
      # and refuses to run; pin a matching field for the install, then restore.
      cp "$fixture_pkg" "$fixture/package.json.orig"
      node -e '
        const fs = require("node:fs");
        const [file, yarnVersion] = process.argv.slice(1);
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        manifest.packageManager = `yarn@${yarnVersion}`;
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
      ' "$fixture_pkg" "$(yarn --version)"
      (cd "$fixture" && yarn install --ignore-engines)
      restore_manifest
      ;;
    bun)   (cd "$fixture" && bun install) ;;
  esac
  node "$fixture/index.mjs"
}

for pm in npm pnpm yarn bun; do
  command -v "$pm" >/dev/null || { echo "skip $pm (not installed)"; continue; }
  run_pm "$pm"
done
echo "All available package managers resolved the three @alitycs packages."
