/**
 * The small synchronous storage surface needed by the delivery WAL. It deliberately mirrors
 * localStorage so callers can provide an encrypted, namespaced, or test-backed implementation
 * without pulling a browser dependency into the core package.
 */
export interface EventStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage useful for Node applications and deterministic tests. */
export class MemoryEventStorage implements EventStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

/**
 * Selects a usable event store. A storage object is probed before it is returned because a
 * browser may expose localStorage while denying writes (private mode, blocked cookies, quota).
 */
export function selectEventStorage(storage?: EventStorage | null): EventStorage | null {
  const candidate = storage ?? getBrowserStorage();
  if (!candidate) return null;

  const probeKey = '__alitycs_event_storage_probe__';
  try {
    candidate.setItem(probeKey, '1');
    candidate.removeItem(probeKey);
    return candidate;
  } catch {
    return null;
  }
}

function getBrowserStorage(): EventStorage | null {
  if (typeof globalThis === 'undefined') return null;
  try {
    const candidate = (globalThis as Record<string, unknown>).localStorage;
    if (!candidate || typeof candidate !== 'object') return null;
    return candidate as EventStorage;
  } catch {
    // Sandboxed iframes can throw on the property access itself.
    return null;
  }
}
