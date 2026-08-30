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

rm -rf "$fixture/node_modules" "$fixture/bun.lock" "$fixture/bun.lockb" \
  "$fixture/package-lock.json" "$fixture/pnpm-lock.yaml" "$fixture/yarn.lock"

restore_manifest() {
  if [ -f "$fixture/package.json.orig" ]; then
    mv "$fixture/package.json.orig" "$fixture_pkg"
  fi
}
trap restore_manifest EXIT

pin_fixture_package_manager() {
  local package_manager="$1"
  cp "$fixture_pkg" "$fixture/package.json.orig"
  node -e '
    const fs = require("node:fs");
    const [file, packageManager] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.packageManager = packageManager;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  ' "$fixture_pkg" "$package_manager"
}

run_pm() {
  local pm="$1"
  echo "== $pm =="
  rm -rf "$fixture/node_modules" "$fixture/.yarn-cache" "$fixture/bun.lock" \
    "$fixture/bun.lockb" "$fixture/package-lock.json" "$fixture/pnpm-lock.yaml" \
    "$fixture/yarn.lock"
  case "$pm" in
    npm)   (cd "$fixture" && npm install --no-audit --no-fund --loglevel=error) ;;
    pnpm)
      # Corepack and pnpm walk up to the Bun workspace manifest unless the
      # clean-room fixture declares the exact package manager under test.
      pin_fixture_package_manager "pnpm@11.23.0"
      (cd "$fixture" && pnpm install --no-frozen-lockfile)
      restore_manifest
      ;;
    yarn)
      # Yarn 1 walks up to the repo root, adopts its non-yarn packageManager field
      # and refuses to run; pin a matching field for the install, then restore.
      pin_fixture_package_manager "yarn@1.22.22"
      (cd "$fixture" && yarn install --force --ignore-engines --cache-folder .yarn-cache)
      restore_manifest
      ;;
    bun)   (cd "$fixture" && bun install) ;;
  esac
  node "$fixture/index.mjs"
}

for pm in npm pnpm yarn bun; do
  command -v "$pm" >/dev/null || {
    echo "error: required package manager '$pm' is not installed" >&2
    exit 1
  }
  run_pm "$pm"
done
echo "npm, pnpm, Yarn, and Bun resolved the three @alitycs packages."
