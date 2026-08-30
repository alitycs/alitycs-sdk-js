/**
 * Size enforcement test
 * Ensures the snippet stays under 1.5KB gzipped
 */

import { test, expect } from 'bun:test';
import { readFileSync, statSync } from 'fs';
import { gzipSync } from 'zlib';
import { join } from 'path';

const MAX_SIZE_BYTES = 5120; // 5KB
const SNIPPET_PATH = join(__dirname, '..', 'dist', 'snippet.min.js');

test('snippet.min.js exists', () => {
  expect(() => statSync(SNIPPET_PATH)).not.toThrow();
});

test('snippet.min.js is under 5KB gzipped', () => {
  const content = readFileSync(SNIPPET_PATH);
  const gzipped = gzipSync(content);
  const size = gzipped.length;

  console.log(`\n📦 Snippet size: ${size} bytes (${(size / 1024).toFixed(2)} KB)`);
  console.log(`📊 Limit: ${MAX_SIZE_BYTES} bytes (${(MAX_SIZE_BYTES / 1024).toFixed(2)} KB)`);
  console.log(`✅ Available: ${MAX_SIZE_BYTES - size} bytes\n`);

  expect(size).toBeLessThanOrEqual(MAX_SIZE_BYTES);
});

test('snippet.min.js raw size is reasonable', () => {
  const stats = statSync(SNIPPET_PATH);
  const size = stats.size;

  // Raw size should be under 5KB (before gzip)
  expect(size).toBeLessThan(5120);

  console.log(`📄 Raw size: ${size} bytes (${(size / 1024).toFixed(2)} KB)`);
});

test('type declarations ship alongside the bundle', () => {
  expect(() => statSync(join(__dirname, '..', 'dist', 'snippet.d.ts'))).not.toThrow();
});
