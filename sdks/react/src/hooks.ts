import { useCallback, useContext, useEffect, useRef } from 'react';
import type { BrowserAlitycs, EventOptions } from '@alitycs/browser';
import { AlitycsContext } from './provider';

/**
 * The browser client behind the enclosing `<AlitycsProvider>`.
 *
 * Returns `null` during server rendering and on a client before hydration has
 * constructed it; throws if there is no provider above the caller.
 */
export function useAlitycs(): BrowserAlitycs | null {
  const client = useContext(AlitycsContext);
  if (client === undefined) {
    throw new Error(
      'useAlitycs must be used within <AlitycsProvider>. Wrap your component tree with <AlitycsProvider apiKey="...">.'
    );
  }
  return client;
}

export type TrackFn = (eventName: string, properties?: Record<string, unknown>, options?: EventOptions) => void;

/**
 * `track` bound to the provider's client. The returned function is
 * referentially stable for the lifetime of the component, so it is safe as a
 * `useEffect` dependency. On the server (no client yet) it is a no-op.
 */
export function useTrack(): TrackFn {
  const client = useAlitycs();
  const clientRef = useRef(client);
  clientRef.current = client;

  return useCallback((eventName, properties, options) => {
    clientRef.current?.track(eventName, properties, options);
  }, []);
}

/**
 * Opt-in page view: fires `page(pathname)` on mount and every time `pathname`
 * changes. `properties` are read at fire time — changing them alone does not
 * re-fire. No-op on the server.
 */
export function useAlitycsPageView(pathname: string, properties?: Record<string, unknown>): void {
  const client = useAlitycs();
  const propertiesRef = useRef(properties);
  propertiesRef.current = properties;

  useEffect(() => {
    client?.page(pathname, propertiesRef.current);
  }, [client, pathname]);
}
