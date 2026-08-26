import { createContext, useEffect, useState, type ReactNode } from 'react';
import { BrowserAlitycs, type BrowserConfig } from '@alitycs/browser';

/**
 * `undefined` means "outside a provider" (the context default); `null` means
 * "inside a provider that has not constructed the client" — the server-render
 * case, where constructing it would touch `window`.
 */
export const AlitycsContext = createContext<BrowserAlitycs | null | undefined>(undefined);

export interface AlitycsProviderProps {
  /** Publishable key. Required; the provider throws during render without one. */
  apiKey: string;
  /** Rest of the browser SDK config (`autoCapture`, batching, retries, ...). */
  config?: Omit<BrowserConfig, 'apiKey'>;
  children?: ReactNode;
}

/**
 * Providers with an identical `{ apiKey, ...config }` share one live client and
 * refcount it. The count is what makes React StrictMode safe: its
 * mount → unmount → mount cycle must not tear down a client the tree is still
 * using, and the lazy state initialiser must not construct a second client for
 * the same config (StrictMode double-invokes initialisers).
 */
interface SharedClient {
  client: BrowserAlitycs;
  consumers: number;
  /** Set between a release-to-zero and the deferred shutdown firing. */
  shutdownTimer: ReturnType<typeof setTimeout> | null;
}

const sharedClients = new Map<string, SharedClient>();

/** Stable identity for `{ apiKey, ...config }`: sorted-key JSON (functions excluded). */
function configIdentity(apiKey: string, config?: Omit<BrowserConfig, 'apiKey'>): string {
  return stableStringify({ ...(config ?? {}), apiKey });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'function' && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Finds the shared client for `key`, creating (or re-creating) it if needed. */
function lookupOrCreateClient(key: string, create: () => BrowserAlitycs): SharedClient {
  const existing = sharedClients.get(key);
  // An instance shut down out-of-band (host code calling shutdown() directly)
  // is dead — never hand it out again.
  if (existing && !existing.client.isShutdown) return existing;

  const entry: SharedClient = { client: create(), consumers: 0, shutdownTimer: null };
  sharedClients.set(key, entry);
  return entry;
}

/**
 * Drops one consumer. Shutdown is deferred by a macrotask so a synchronous
 * remount (React StrictMode, remount-on-key-change patterns) reuses the same
 * live client instead of losing its queue and timers; when no one re-acquires,
 * the timer shuts the client down — which drains everything still queued.
 */
function releaseClient(key: string, entry: SharedClient): void {
  entry.consumers -= 1;
  if (entry.consumers > 0 || entry.shutdownTimer !== null || sharedClients.get(key) !== entry) return;

  entry.shutdownTimer = setTimeout(() => {
    entry.shutdownTimer = null;
    if (entry.consumers === 0 && sharedClients.get(key) === entry) {
      sharedClients.delete(key);
      void entry.client.shutdown();
    }
  }, 0);
}

/**
 * Constructs (or joins) the browser client and hands it to {@link useAlitycs},
 * {@link useTrack}, and {@link useAlitycsPageView}.
 *
 * The client is created in a lazy state initialiser guarded by
 * `typeof window === 'undefined'`, so on the server nothing is constructed and
 * children render unchanged — there is no window/document access at module
 * scope or anywhere else during render, and hydration produces identical
 * output. On the client the instance exists from the very first render, so
 * children can call it from their own mount effects (which run before this
 * provider's effects).
 *
 * Lifecycle: providers sharing the same config identity share one client; the
 * client is shut down only after the last of them unmounts (deferred one tick).
 * Changing `apiKey` or `config` after mount has no effect — remount the
 * provider (React `key`) to join a different client.
 */
export function AlitycsProvider({ apiKey, config, children }: AlitycsProviderProps) {
  const [shared] = useState<{ key: string; entry: SharedClient } | null>(() => {
    if (typeof window === 'undefined') return null;
    const key = configIdentity(apiKey, config);
    // StrictMode double-invokes this initialiser; the registry makes both runs
    // resolve to the same instance instead of constructing two clients.
    return { key, entry: lookupOrCreateClient(key, () => BrowserAlitycs.init({ ...config, apiKey })) };
  });

  useEffect(() => {
    if (!shared) return undefined;
    shared.entry.consumers += 1;
    // A pending deferred shutdown means the previous consumer group unmounted
    // within the last tick — keep this (still live) client instead.
    if (shared.entry.shutdownTimer !== null) {
      clearTimeout(shared.entry.shutdownTimer);
      shared.entry.shutdownTimer = null;
    }
    return () => releaseClient(shared.key, shared.entry);
  }, [shared]);

  return <AlitycsContext.Provider value={shared?.entry.client ?? null}>{children}</AlitycsContext.Provider>;
}
