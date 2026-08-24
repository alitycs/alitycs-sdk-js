import { describe, expect, test } from 'bun:test';

import { DEFAULT_SDK_URL } from '../src/config';

describe('CDN default', () => {
  test('is an exact-version npm CDN URL, never a floating range', () => {
    expect(DEFAULT_SDK_URL).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@alitycs\/browser@\d+\.\d+\.\d+\/dist\/browser\.min\.js$/
    );
    expect(DEFAULT_SDK_URL).not.toContain('@latest');
    expect(DEFAULT_SDK_URL).not.toContain('sdk@');
  });
});
