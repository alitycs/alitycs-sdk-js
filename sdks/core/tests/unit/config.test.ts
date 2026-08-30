import { describe, expect, test } from 'bun:test';
import { DEFAULTS, resolveAlitycsConfig } from '../../src/config';
import { MemoryEventStorage } from '../../src/storage';

describe('resolveAlitycsConfig', () => {
  test('applies shared defaults and normalizes boolean persistence', () => {
    const resolved = resolveAlitycsConfig({ apiKey: 'key', persistence: true });
    expect(resolved).toMatchObject({
      endpoint: DEFAULTS.endpoint,
      flushInterval: DEFAULTS.flushInterval,
      flushSize: DEFAULTS.flushSize,
      maxQueueSize: DEFAULTS.maxQueueSize,
      persistence: {},
      overflowPolicy: 'drop-newest',
    });
  });

  test('preserves explicit adapter options and adapter defaults', () => {
    const storage = new MemoryEventStorage();
    const resolved = resolveAlitycsConfig({
      apiKey: 'key',
      endpoint: 'https://custom.test/events',
      persistence: { storage, maxRestoredEvents: 10 },
      overflowPolicy: 'drop-oldest',
    });
    expect(resolved.endpoint).toBe('https://custom.test/events');
    expect(resolved.persistence).toEqual({ storage, maxRestoredEvents: 10 });
    expect(resolved.overflowPolicy).toBe('drop-oldest');
  });

  test('honors persistence supplied by adapter defaults', () => {
    const storage = new MemoryEventStorage();
    const resolved = resolveAlitycsConfig({ apiKey: 'key' }, { persistence: { storage } });

    expect(resolved.persistence).toEqual({ storage });
  });

  test('rejects non-positive batching settings for every adapter', () => {
    expect(() => resolveAlitycsConfig({ apiKey: 'key', flushSize: 0 })).toThrow('must be positive numbers');
    expect(() => resolveAlitycsConfig({ apiKey: 'key', maxQueueSize: Number.NaN })).toThrow('must be positive numbers');
    expect(() => resolveAlitycsConfig({ apiKey: 'key', flushInterval: -1 })).toThrow('must be positive numbers');
  });

  test('rejects blank API keys', () => {
    expect(() => resolveAlitycsConfig({ apiKey: ' ' })).toThrow('apiKey is required');
  });
});
