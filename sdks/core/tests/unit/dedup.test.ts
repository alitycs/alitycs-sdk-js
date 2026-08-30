import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventDeduplicator } from '../../src/dedup';

describe('EventDeduplicator', () => {
  let dedup: EventDeduplicator;
  let originalDateNow: typeof Date.now;
  let now: number;

  beforeEach(() => {
    dedup = new EventDeduplicator();
    originalDateNow = Date.now;
    now = 1000000;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test('first call passes, repeat within window is dropped', () => {
    expect(dedup.isDuplicate('key-1', 500)).toBe(false);
    expect(dedup.isDuplicate('key-1', 500)).toBe(true);
  });

  test('passes after window expires', () => {
    expect(dedup.isDuplicate('key-1', 500)).toBe(false);
    now += 501;
    expect(dedup.isDuplicate('key-1', 500)).toBe(false);
  });

  test('different keys do not interfere', () => {
    expect(dedup.isDuplicate('key-a', 500)).toBe(false);
    expect(dedup.isDuplicate('key-b', 500)).toBe(false);
    expect(dedup.isDuplicate('key-a', 500)).toBe(true);
    expect(dedup.isDuplicate('key-b', 500)).toBe(true);
  });

  test('custom windowMs is respected', () => {
    expect(dedup.isDuplicate('key-1', 1000)).toBe(false);
    now += 500;
    expect(dedup.isDuplicate('key-1', 1000)).toBe(true);
    now += 501;
    expect(dedup.isDuplicate('key-1', 1000)).toBe(false);
  });

  test('default 500ms when not specified via isDuplicate', () => {
    expect(dedup.isDuplicate('key-1', 500)).toBe(false);
    now += 499;
    expect(dedup.isDuplicate('key-1', 500)).toBe(true);
    now += 2;
    expect(dedup.isDuplicate('key-1', 500)).toBe(false);
  });

  test('clear() empties the map', () => {
    dedup.isDuplicate('key-1', 500);
    dedup.isDuplicate('key-2', 500);
    expect(dedup.size).toBe(2);

    dedup.clear();
    expect(dedup.size).toBe(0);

    // Previously duplicate key now passes
    expect(dedup.isDuplicate('key-1', 500)).toBe(false);
  });

  test('map does not exceed 10,000 entries', () => {
    for (let i = 0; i < 10_001; i++) {
      dedup.isDuplicate(`key-${i}`, 60_000);
    }
    expect(dedup.size).toBeLessThanOrEqual(10_000);
  });

  test('expired entries are cleaned up on interval', () => {
    // Add entries with short window
    for (let i = 0; i < 50; i++) {
      dedup.isDuplicate(`key-${i}`, 100);
    }
    expect(dedup.size).toBe(50);

    // Advance time past expiry
    now += 200;

    // Trigger cleanup by reaching 100 total calls
    for (let i = 50; i < 100; i++) {
      dedup.isDuplicate(`key-${i}`, 60_000);
    }

    // The first 50 expired entries should have been cleaned
    expect(dedup.size).toBe(50);
  });

  test('eviction prefers expired entries over oldest live ones', () => {
    // 9_000 long-lived entries inserted before 1_000 soon-to-expire ones: under FIFO eviction
    // the L keys would go first, under expiry-first eviction every E key goes instead.
    for (let i = 0; i < 9_000; i++) {
      dedup.isDuplicate(`L-${i}`, 60_000);
    }
    now += 1_000;
    for (let i = 0; i < 1_000; i++) {
      dedup.isDuplicate(`E-${i}`, 50);
    }
    now += 100; // E-* expired, L-* still live
    expect(dedup.size).toBe(10_000);

    // Overflow by one — call count stays off the cleanup interval so evict() does the work.
    // Expiry-first eviction removes exactly the 1_000 dead E entries and nothing else.
    expect(dedup.isDuplicate('N-0', 60_000)).toBe(false);
    expect(dedup.size).toBe(9_001);

    expect(dedup.isDuplicate('L-0', 60_000)).toBe(true);
    expect(dedup.isDuplicate('N-0', 60_000)).toBe(true);
    expect(dedup.isDuplicate('E-0', 500)).toBe(false);
  });
});
