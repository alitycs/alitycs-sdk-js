'use client';

import { useEffect, useRef, Suspense } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRouter } from 'next/router';
import { useAlitycs } from '@alitycs/react';

export type RouterKind = 'app' | 'pages';
export type RouterOption = RouterKind | 'auto';

/**
 * Picks the tracker without calling either router's hooks — `usePathname()`
 * throws outside the App Router and `useRouter()` warns inside it, so the
 * decision has to come first. The Pages Router always mounts at `#__next`;
 * anything else is treated as the App Router. Pass `router` to
 * `<AlitycsProvider>` when markup or embedding defeats the heuristic.
 *
 * Only called on the client: page views are a client-only concern, so the
 * trackers render nothing during server rendering.
 */
export function detectRouter(): RouterKind {
  if (typeof document === 'undefined') return 'app';
  return document.getElementById('__next') !== null ? 'pages' : 'app';
}

export interface RouteChangeTrackerProps {
  router: RouterOption;
  properties?: Record<string, unknown>;
}

/** Renders the page-view tracker for the detected (or configured) router. */
export function RouteChangeTracker({ router, properties }: RouteChangeTrackerProps) {
  if (typeof document === 'undefined') return null;
  const kind = router === 'auto' ? detectRouter() : router;
  return kind === 'app' ? <AppRouterTracker properties={properties} /> : <PagesRouterTracker properties={properties} />;
}

function AppRouterTracker({ properties }: { properties?: Record<string, unknown> }) {
  return (
    // useSearchParams() forces the nearest boundary to client-render. The
    // boundary lives HERE, around only the tracker, so consumers do not need
    // one of their own — without it their production build fails with the
    // "useSearchParams() should be wrapped in a suspense boundary" de-opt,
    // and with it their pages keep static rendering while tracking still sees
    // query params once hydration resolves.
    <Suspense fallback={null}>
      <AppRouterPageView properties={properties} />
    </Suspense>
  );
}

function AppRouterPageView({ properties }: { properties?: Record<string, unknown> }) {
  const client = useAlitycs();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const propertiesRef = useRef(properties);
  propertiesRef.current = properties;

  useEffect(() => {
    // pathname is null during prerendering/hydration of not-yet-resolved
    // segments; searchParams suspension is handled by the boundary above.
    if (!client || pathname === null) return;
    const query = searchParams?.toString();
    const pathWithQuery = query ? `${pathname}?${query}` : pathname;
    client.page(pathname, {
      url: absoluteUrl(pathWithQuery),
      ...propertiesRef.current,
    });
  }, [client, pathname, searchParams]);

  return null;
}

const ROUTE_CHANGE_COMPLETE = 'routeChangeComplete' as const;

function PagesRouterTracker({ properties }: { properties?: Record<string, unknown> }) {
  const client = useAlitycs();
  const router = useRouter();
  const propertiesRef = useRef(properties);
  propertiesRef.current = properties;

  useEffect(() => {
    if (!client) return undefined;

    const sendPageView = () => {
      const asPath = router.asPath || '/';
      const pathname = asPath.split(/[?#]/)[0] || '/';
      client.page(pathname, {
        url: absoluteUrl(asPath),
        ...propertiesRef.current,
      });
    };

    // The initial route never passes through routeChangeComplete.
    sendPageView();
    router.events.on(ROUTE_CHANGE_COMPLETE, sendPageView);
    return () => {
      router.events.off(ROUTE_CHANGE_COMPLETE, sendPageView);
    };
  }, [client, router]);

  return null;
}

function absoluteUrl(pathWithQuery: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return new URL(pathWithQuery, window.location.origin).toString();
  } catch {
    return undefined;
  }
}
