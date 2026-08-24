import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installDom, startCaptureServer, uninstallDom, withoutGlobals, type CaptureServerHandle } from './helpers';

installDom();

/**
 * This file exercises the App Router path. `next/navigation` is mocked so the
 * route can be changed programmatically; `next/router` stays real, and any
 * accidental invocation of the Pages Router tracker fails the test with
 * next's own "expected app router" invariant.
 */
let pathname: string | null = '/';
let searchParams = new URLSearchParams();
let suspendSearchParams = false;

function navigationMock() {
  return {
    usePathname: () => pathname,
    useSearchParams: (): URLSearchParams => {
      if (suspendSearchParams) {
        // Suspend forever, exactly like a not-yet-resolved search-param
        // segment during prerendering/hydration.
        throw new Promise<never>(() => {});
      }
      return searchParams;
    },
  };
}

mock.module('next/navigation', navigationMock);

type NextjsModule = typeof import('../src/index');

let rtl: typeof import('@testing-library/react');
let nextjs: NextjsModule;

let capture: CaptureServerHandle;

beforeAll(async () => {
  rtl = await import('@testing-library/react');
  nextjs = await import('../src/index');
});

afterAll(() => {
  uninstallDom();
});

beforeEach(() => {
  // Detection runs per render; keep the ambient DOM in the App Router shape
  // no matter which test files ran earlier in this process.
  document.getElementById('__next')?.remove();
  pathname = '/';
  searchParams = new URLSearchParams();
  suspendSearchParams = false;
  mock.module('next/navigation', navigationMock);
  capture = startCaptureServer();
});

interface Harness {
  /** Re-renders and flushes React effects, so route changes are observable. */
  rerender(): Promise<void>;
  flush(): Promise<void>;
  pageEvents(): Array<Record<string, any>>;
}

const PROVIDER_CONFIG = (endpoint: string) => ({
  endpoint,
  autoCapture: false,
  flushInterval: 3_600_000,
  flushSize: 25,
  maxRetries: 0,
});

/**
 * Renders the provider over a probe child that captures the underlying
 * client, so tests can flush on demand exactly as an application would.
 */
async function renderProvider(props: Partial<Parameters<typeof nextjs.AlitycsProvider>[0]> = {}): Promise<Harness> {
  let client: any = null;

  function Probe(): null {
    client = nextjs.useAlitycs();
    return null;
  }

  // Fresh JSX every render: re-rendering the SAME element object lets React
  // bail out, which would hide route changes from the tracker.
  const buildUi = () => (
    <nextjs.AlitycsProvider apiKey="pk_test" config={PROVIDER_CONFIG(capture.url)} {...props}>
      <Probe />
    </nextjs.AlitycsProvider>
  );

  const { rerender } = rtl.render(buildUi());
  expect(client).toBeTruthy();
  return {
    rerender: async () => {
      await rtl.act(async () => {
        rerender(buildUi());
      });
    },
    flush: () => client.flush(),
    pageEvents: () =>
      capture.requests
        .flatMap((request: any) => request.payload?.events ?? [])
        .filter((event: any) => event.eventType === 'page'),
  };
}

describe('AlitycsProvider (App Router)', () => {
  test('fires an automatic page view on mount with the resolved URL', async () => {
    pathname = '/dashboard';
    searchParams = new URLSearchParams('utm_source=email');

    const harness = await renderProvider();
    await harness.flush();

    const events = harness.pageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('/dashboard');
    expect(events[0].properties.url).toBe('https://app.alitycs.test/dashboard?utm_source=email');
    // The URL rides in context too, where UTM parameters are parsed out.
    expect(events[0].context.url).toBe('https://app.alitycs.test/dashboard?utm_source=email');
    expect(events[0].context.utmSource).toBe('email');
  });

  test('fires again when only the query string changes', async () => {
    pathname = '/search';
    searchParams = new URLSearchParams('q=a');

    const harness = await renderProvider();
    await harness.flush();

    searchParams = new URLSearchParams('q=b');
    await harness.rerender();
    await harness.flush();

    expect(harness.pageEvents().map(event => event.properties.url)).toEqual([
      'https://app.alitycs.test/search?q=a',
      'https://app.alitycs.test/search?q=b',
    ]);
  });

  test('fires again when the pathname changes', async () => {
    pathname = '/first';
    const harness = await renderProvider();
    await harness.flush();

    pathname = '/second';
    await harness.rerender();
    await harness.flush();

    expect(harness.pageEvents().map(event => event.event)).toEqual(['/first', '/second']);
  });

  test('does not fire before hydration resolves the route', async () => {
    pathname = null;
    const harness = await renderProvider();
    await harness.flush();
    expect(harness.pageEvents()).toHaveLength(0);
  });

  test('trackPageViews=false disables automatic page views entirely', async () => {
    pathname = '/quiet';
    const harness = await renderProvider({ trackPageViews: false });
    await harness.flush();
    pathname = '/still-quiet';
    await harness.rerender();
    await harness.flush();

    expect(harness.pageEvents()).toHaveLength(0);
  });

  test('merges pageViewProperties into every automatic page view', async () => {
    pathname = '/pricing';
    const harness = await renderProvider({ pageViewProperties: { experiment: 'hero-b' } });
    await harness.flush();

    pathname = '/pricing-v2';
    await harness.rerender();
    await harness.flush();

    const events = harness.pageEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      expect(event.properties.experiment).toBe('hero-b');
    }
  });

  test('keeps children rendering while search params suspend — the Suspense boundary is ours', async () => {
    suspendSearchParams = true;
    pathname = '/suspended';

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: ReturnType<typeof import('react-dom/client').createRoot>;

    try {
      await rtl.act(async () => {
        root = (await import('react-dom/client')).createRoot(container);
        root.render(
          <nextjs.AlitycsProvider apiKey="pk_test" config={PROVIDER_CONFIG(capture.url)}>
            <span id="child-marker">child rendered</span>
          </nextjs.AlitycsProvider>
        );
      });

      // The tracker suspended; its internal boundary swallowed the suspension.
      // Children are untouched, and nothing was tracked for the pending route.
      expect(document.getElementById('child-marker')?.textContent).toBe('child rendered');
      expect(capture.requests).toHaveLength(0);
    } finally {
      await rtl.act(async () => {
        root!.unmount();
      });
      container.remove();
    }
  });

  test('re-exports the @alitycs/react hooks API', () => {
    expect(typeof nextjs.useAlitycs).toBe('function');
    expect(typeof nextjs.useTrack).toBe('function');
    expect(typeof nextjs.useAlitycsPageView).toBe('function');
  });

  test('detectRouter classifies by the Pages Router mount point', () => {
    expect(nextjs.detectRouter()).toBe('app');

    const marker = Object.assign(document.createElement('div'), { id: '__next' });
    document.body.appendChild(marker);
    try {
      expect(nextjs.detectRouter()).toBe('pages');
    } finally {
      marker.remove();
    }

    // Server rendering has no document; trackers render nothing there.
    expect(withoutGlobals(() => nextjs.detectRouter())).toBe('app');
  });
});
