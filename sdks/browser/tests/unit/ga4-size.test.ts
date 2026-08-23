import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';

const MAX_GZIP_SIZE_BYTES = 8 * 1024;
const BUNDLE_PATH = join(__dirname, '..', '..', 'dist', 'ga4.min.js');

test('standalone GA4 bridge bundle exists', () => {
  expect(() => statSync(BUNDLE_PATH)).not.toThrow();
});

test('standalone GA4 bridge bundle is at most 8KB gzipped', () => {
  const size = gzipSync(readFileSync(BUNDLE_PATH)).length;
  expect(size).toBeLessThanOrEqual(MAX_GZIP_SIZE_BYTES);
});
