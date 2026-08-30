import { expect, test } from 'bun:test';
import { installDom, uninstallDom } from './helpers';

const GLOBAL_KEYS = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

test('installDom and uninstallDom restore every ambient global descriptor', () => {
  const originals = new Map(GLOBAL_KEYS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  const markers = new Map<string, object>();

  try {
    for (const key of GLOBAL_KEYS) {
      const marker = { key };
      markers.set(key, marker);
      Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: marker,
      });
    }

    installDom();
    for (const key of GLOBAL_KEYS) expect((globalThis as Record<string, unknown>)[key]).not.toBe(markers.get(key));

    uninstallDom();
    for (const key of GLOBAL_KEYS) {
      expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual({
        configurable: true,
        enumerable: true,
        writable: false,
        value: markers.get(key),
      });
    }
  } finally {
    uninstallDom();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
