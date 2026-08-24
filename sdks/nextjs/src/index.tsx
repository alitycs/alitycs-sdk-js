'use client';

import {
  AlitycsProvider as ReactAlitycsProvider,
  type AlitycsProviderProps as ReactAlitycsProviderProps,
} from '@alitycs/react';
import { RouteChangeTracker, type RouterOption } from './router-tracking';

export { useAlitycs, useTrack, useAlitycsPageView, type TrackFn } from '@alitycs/react';
// Client-facing types ride on the wrapper's own dependency graph — nothing
// here imports @alitycs/browser directly.
export type { BrowserAlitycs, BrowserConfig } from '@alitycs/react';
export type { EventOptions } from '@alitycs/core';
export { detectRouter, type RouterKind, type RouterOption } from './router-tracking';

export interface AlitycsProviderProps extends ReactAlitycsProviderProps {
  /** Fire a `page` event on mount and every route change. Default `true`. */
  trackPageViews?: boolean;
  /**
   * Which router the app uses. `'auto'` (default) detects the Pages Router by
   * its `#__next` mount point and treats everything else as the App Router —
   * set `'app'` or `'pages'` to skip detection.
   */
  router?: RouterOption;
  /** Extra properties merged into every automatic page view. */
  pageViewProperties?: Record<string, unknown>;
}

/**
 * Next.js analytics provider: mounts the {@link @alitycs/react} provider and
 * adds automatic route-change page views for both routers.
 *
 * ```tsx
 * // app/layout.tsx
 * <AlitycsProvider apiKey={process.env.NEXT_PUBLIC_ALITYCS_KEY!}>
 *   {children}
 * </AlitycsProvider>
 * ```
 *
 * The tracker renders no DOM, is wrapped in its own Suspense boundary (so
 * `useSearchParams()` never de-opts the consumer's pages into client
 * rendering), and is skipped entirely during server rendering. Everything else
 * — batching, sessions, retry, autocapture config — is the browser SDK; see
 * {@link ReactAlitycsProviderProps} for the forwarded `config`.
 */
export function AlitycsProvider({
  trackPageViews = true,
  router = 'auto',
  pageViewProperties,
  apiKey,
  config,
  children,
}: AlitycsProviderProps) {
  return (
    <ReactAlitycsProvider apiKey={apiKey} config={config}>
      {trackPageViews ? <RouteChangeTracker router={router} properties={pageViewProperties} /> : null}
      {children}
    </ReactAlitycsProvider>
  );
}
