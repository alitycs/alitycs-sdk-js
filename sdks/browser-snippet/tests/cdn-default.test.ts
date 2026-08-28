import { describe, expect, test } from 'bun:test';

import { STRICT_SEMVER_SOURCE, isStrictSemVer } from '../../../scripts/strict-semver';
import { DEFAULT_SDK_URL } from '../src/config';

describe('CDN default', () => {
  test('is an exact-version npm CDN URL, never a floating range', () => {
    const exactCdnPattern = new RegExp(
      `^https://cdn\\.jsdelivr\\.net/npm/@alitycs/browser@(?:${STRICT_SEMVER_SOURCE})/dist/browser\\.min\\.js$`
    );

    expect(DEFAULT_SDK_URL).toMatch(exactCdnPattern);
    expect('https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.3-rc.1/dist/browser.min.js').toMatch(exactCdnPattern);
    expect('https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.3+build.7/dist/browser.min.js').toMatch(exactCdnPattern);
    expect(DEFAULT_SDK_URL).not.toContain('@latest');
    expect(DEFAULT_SDK_URL).not.toContain('sdk@');
  });

  test('rejects malformed and ambiguous semantic versions', () => {
    expect(isStrictSemVer('1.0.2')).toBe(true);
    expect(isStrictSemVer('1.0.3-rc.1+build.7')).toBe(true);
    expect(isStrictSemVer('1.0.2foo')).toBe(false);
    expect(isStrictSemVer('1.0.2/other')).toBe(false);
    expect(isStrictSemVer('1.0.0.1')).toBe(false);
    expect(isStrictSemVer('01.0.0')).toBe(false);
    expect(isStrictSemVer('1.0.0-01')).toBe(false);
  });
});
