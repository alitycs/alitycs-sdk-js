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
 * Constructs the browser client once per mounted provider and hands it to
 * {@link useAlitycs}, {@link useTrack}, and {@link useAlitycsPageView}.
 *
 * The client is created in a lazy state initialiser guarded by
 * `typeof window === 'undefined'`, so on the server nothing is constructed and
 * children render unchanged — there is no window/document access at module
 * scope or anywhere else during render, and hydration produces identical
 * output. On the client the instance exists from the very first render, so
 * children can call it from their own mount effects (which run before this
 * provider's effects). Changing `apiKey` or `config` after mount has no
 * effect — remount the provider (React `key`) to re-initialise.
 */
export function AlitycsProvider({ apiKey, config, children }: AlitycsProviderProps) {
  const [client] = useState<BrowserAlitycs | null>(() =>
    typeof window === 'undefined' ? null : BrowserAlitycs.init({ ...config, apiKey })
  );

  // SPA teardown must not strand queued events: shutdown drains everything.
  useEffect(() => {
    return () => {
      void client?.shutdown();
    };
  }, [client]);

  return <AlitycsContext.Provider value={client}>{children}</AlitycsContext.Provider>;
}
