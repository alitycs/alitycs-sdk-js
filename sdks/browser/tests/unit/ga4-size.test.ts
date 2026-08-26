import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';

// Raised from 8KB in the 2026-08-24 delivery-reliability remediation: the standalone GA4
// bundle inlines @alitycs/core, and core gained enqueue-time event validation, transport
// send outcomes with an abort timeout, split-on-HTTP-400, and requeue-on-transient-failure.
// The previous 8KB cap had only ~62 gzip bytes of headroom — far less than those safety
// features cost. Budget reopens headroom for future delivery-reliability work.
const MAX_GZIP_SIZE_BYTES = 10 * 1024;
const BUNDLE_PATH = join(__dirname, '..', '..', 'dist', 'ga4.min.js');

test('standalone GA4 bridge bundle exists', () => {
  expect(() => statSync(BUNDLE_PATH)).not.toThrow();
});

test('standalone GA4 bridge bundle is at most 10KB gzipped', () => {
  const size = gzipSync(readFileSync(BUNDLE_PATH)).length;
  expect(size).toBeLessThanOrEqual(MAX_GZIP_SIZE_BYTES);
});
