/**
 * Builds @alitycs/browser-snippet with the CDN URL injected from the current
 * @alitycs/browser version, keeping source and artifact in lockstep.
 */
import { $ } from "bun";
import { isStrictSemVer } from "./strict-semver";

const browserPkg = await Bun.file(
  new URL("../sdks/browser/package.json", import.meta.url),
).json();
const version: string = browserPkg.version;
if (!isStrictSemVer(version)) {
  throw new Error(`Unexpected @alitycs/browser version: ${version}`);
}
const cdnUrl = `https://cdn.jsdelivr.net/npm/@alitycs/browser@${version}/dist/browser.min.js`;

const define = `__ALITYCS_BROWSER_CDN_URL__:'${cdnUrl}'`;

await $`bun build sdks/browser-snippet/src/snippet.ts --outfile=sdks/browser-snippet/dist/snippet.js --target=browser --format=iife --sourcemap=inline --define ${define}`;
await $`bun build sdks/browser-snippet/src/snippet.ts --outfile=sdks/browser-snippet/dist/snippet.min.js --target=browser --format=iife --minify --define ${define}`;

console.log(`Built snippet with CDN default: ${cdnUrl}`);
