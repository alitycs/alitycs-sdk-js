import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';

// Raised from 8KB in the 2026-08-24 delivery-reliability remediation: the standalone GA4
// bundle inlines @alitycs/core, and core gained enqueue-time event validation, transport
// send outcomes with an abort timeout, split-on-HTTP-400, and requeue-on-transient-failure.
// The previous 8KB cap had only ~62 gzip bytes of headroom — far less than those safety
// features cost. Budget reopens headroom for the planned retry-handling extension.
//
// Raised from 9KB for the identity-correctness surface: core's Alitycs class gained
// alias()/set()/setOnce()/unset() plus the shared buildAnalyticsEvent/validateEvent
// module (event.ts), and class methods cannot be tree-shaken out of an inlined-core
// bundle. Measured 9377 gzip bytes after that change — over a cap that had ~160
// bytes of headroom left.
const MAX_GZIP_SIZE_BYTES = 10 * 1024;
const BUNDLE_PATH = join(__dirname, '..', '..', 'dist', 'ga4.min.js');

test('standalone GA4 bridge bundle exists', () => {
  expect(() => statSync(BUNDLE_PATH)).not.toThrow();
});

test('standalone GA4 bridge bundle is at most 10KB gzipped', () => {
  const size = gzipSync(readFileSync(BUNDLE_PATH)).length;
  expect(size).toBeLessThanOrEqual(MAX_GZIP_SIZE_BYTES);
});
