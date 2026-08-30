import { describe, expect, test } from 'bun:test';
import { MemoryEventStorage, selectEventStorage, type EventStorage } from '../../src/storage';

describe('event storage', () => {
  test('MemoryEventStorage implements the localStorage-shaped adapter', () => {
    const storage = new MemoryEventStorage();
    expect(storage.getItem('missing')).toBeNull();
    storage.setItem('key', 'value');
    expect(storage.getItem('key')).toBe('value');
    storage.removeItem('key');
    expect(storage.getItem('key')).toBeNull();
    storage.setItem('another', 'value');
    storage.clear();
    expect(storage.getItem('another')).toBeNull();
  });

  test('selectEventStorage probes usable adapters and rejects failing adapters', () => {
    const usable = new MemoryEventStorage();
    expect(selectEventStorage(usable)).toBe(usable);

    const failing: EventStorage = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {},
    };
    expect(selectEventStorage(failing)).toBeNull();
  });

  test('selectEventStorage returns null when no browser storage is available', () => {
    expect(selectEventStorage()).toBeNull();
  });

  test('selectEventStorage degrades safely when localStorage access throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });

    try {
      expect(selectEventStorage()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
