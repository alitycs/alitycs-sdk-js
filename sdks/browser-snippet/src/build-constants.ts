/**
 * Build-time injected exact-version CDN URL for @alitycs/browser.
 * scripts/build-snippet-with-cdn.ts derives it from sdks/browser/package.json and passes
 * bun build --define __ALITYCS_BROWSER_CDN_URL__. The literal below is the identical
 * fallback so plain `bun test` / un-injected builds resolve the same value.
 */
declare const __ALITYCS_BROWSER_CDN_URL__: string | undefined;

export const BROWSER_VERSION = '1.0.3';

export const DEFAULT_SDK_URL: string =
  typeof __ALITYCS_BROWSER_CDN_URL__ === 'string'
    ? __ALITYCS_BROWSER_CDN_URL__
    : `https://cdn.jsdelivr.net/npm/@alitycs/browser@${BROWSER_VERSION}/dist/browser.min.js`;
