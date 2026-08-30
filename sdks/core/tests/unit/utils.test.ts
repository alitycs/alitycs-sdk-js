import { describe, test, expect } from 'bun:test';
import { generateId, serializeProperties } from '../../src/utils';

describe('generateId', () => {
  test('returns a string', () => {
    expect(typeof generateId()).toBe('string');
  });

  test('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  test('looks like a UUID', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('uses getRandomValues when crypto.randomUUID is unavailable', () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (bytes: Uint8Array) => {
          bytes.fill(0xab);
          return bytes;
        },
      },
    });

    try {
      expect(generateId()).toBe('abababab-abab-4bab-abab-abababababab');
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      } else {
        delete (globalThis as { crypto?: unknown }).crypto;
      }
    }
  });

  test('fails closed when secure randomness is unavailable', () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });

    try {
      expect(() => generateId()).toThrow('Web Crypto required');
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      } else {
        delete (globalThis as { crypto?: unknown }).crypto;
      }
    }
  });
});

describe('serializeProperties', () => {
  test('converts primitives to strings', () => {
    expect(serializeProperties({ count: 42, flag: true, name: 'hello' })).toEqual({
      count: '42',
      flag: 'true',
      name: 'hello',
    });
  });

  test('skips undefined values', () => {
    expect(serializeProperties({ a: 1, b: undefined, c: 'x' })).toEqual({
      a: '1',
      c: 'x',
    });
  });

  test('converts null to "null"', () => {
    expect(serializeProperties({ x: null })).toEqual({ x: 'null' });
  });

  test('JSON-stringifies objects', () => {
    expect(serializeProperties({ data: { nested: true } })).toEqual({
      data: '{"nested":true}',
    });
  });

  test('JSON-stringifies arrays', () => {
    expect(serializeProperties({ items: [1, 2, 3] })).toEqual({
      items: '[1,2,3]',
    });
  });

  test('replaces circular references with a placeholder instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => serializeProperties({ data: circular })).not.toThrow();
    expect(serializeProperties({ data: circular })).toEqual({ data: '[unserializable]' });
  });

  test('replaces nested BigInt with a placeholder instead of throwing', () => {
    const result = serializeProperties({ data: { big: BigInt(1), huge: 9007199254740993n } });
    expect(result).toEqual({ data: '[unserializable]' });
  });

  test('replaces objects whose toJSON returns undefined with a placeholder', () => {
    expect(serializeProperties({ data: { toJSON: () => undefined } })).toEqual({
      data: '[unserializable]',
    });
  });

  test('a throwing property does not prevent later properties from serializing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = serializeProperties({ bad: circular, good: 'ok' });
    expect(result.good).toBe('ok');
    expect(result.bad).toBe('[unserializable]');
  });

  test('stringifies top-level BigInt and Symbol values without throwing', () => {
    expect(serializeProperties({ count: BigInt(42), id: Symbol('a') })).toEqual({
      count: '42',
      id: 'Symbol(a)',
    });
  });

  test('returns empty object for empty input', () => {
    expect(serializeProperties({})).toEqual({});
  });
});
