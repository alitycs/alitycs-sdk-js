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

  test('returns empty object for empty input', () => {
    expect(serializeProperties({})).toEqual({});
  });
});
