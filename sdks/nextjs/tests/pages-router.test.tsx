import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { installDom, startCaptureServer, uninstallDom, type CaptureServerHandle } from './helpers';

installDom();

/**
 * This file exercises the Pages Router path. `next/router` is mocked so
 * navigation can be driven programmatically; `next/navigation` stays real, so
 * if detection ever picked the App Router tracker here, its usePathname()
 * call fails the test with next's own "expected app router" invariant.
 */
type PageViewHandler = () => void;

const listeners = new Map<string, Set<PageViewHandler>>();
const routerState = { asPath: '/' };

function navigate(to: string): void {
  routerState.asPath = to;
  for (const handler of listeners.get('routeChangeComplete') ?? []) {
    handler();
  }
}

function listenerCount(eventName: string): number {
  return listeners.get(eventName)?.size ?? 0;
}

mock.module('next/router', () => ({
  useRouter: () => ({
    get asPath() {
      return routerState.asPath;
    },
    events: {
      on(eventName: string, handler: PageViewHandler) {
        if (!listeners.has(eventName)) listeners.set(eventName, new Set());
        listeners.get(eventName)!.add(handler);
      },
      off(eventName: string, handler: PageViewHandler) {
        listeners.get(eventName)?.delete(handler);
      },
    },
  }),
}));

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
  // The Pages Router mounts at #__next — recreate the marker every test so
  // auto-detection picks this router regardless of file execution order.
  document.getElementById('__next')?.remove();
  const marker = Object.assign(document.createElement('div'), { id: '__next' });
  document.body.appendChild(marker);

  listeners.clear();
  routerState.asPath = '/';
  capture = startCaptureServer();
});

interface Harness {
  flush(): Promise<void>;
  pageEvents(): Array<Record<string, any>>;
}

async function renderPagesProvider(
  props: Partial<Parameters<typeof nextjs.AlitycsProvider>[0]> = {}
): Promise<Harness> {
  let client: any = null;

  function Probe(): null {
    client = nextjs.useAlitycs();
    return null;
  }

  rtl.render(
    <nextjs.AlitycsProvider
      apiKey="pk_test"
      config={{
        endpoint: capture.url,
        autoCapture: false,
        flushInterval: 3_600_000,
        flushSize: 25,
        maxRetries: 0,
      }}
      {...props}
    >
      <Probe />
    </nextjs.AlitycsProvider>
  );
  expect(client).toBeTruthy();

  return {
    flush: () => client.flush(),
    pageEvents: () =>
      capture.requests
        .flatMap((request: any) => request.payload?.events ?? [])
        .filter((event: any) => event.eventType === 'page'),
  };
}

describe('AlitycsProvider (Pages Router)', () => {
  test('fires a page view on mount from router.asPath', async () => {
    routerState.asPath = '/products/42?utm_source=e2e&utm_campaign=launch';

    const harness = await renderPagesProvider();
    await harness.flush();

    const events = harness.pageEvents();
    expect(events).toHaveLength(1);
    // The tracked name is the path without the query.
    expect(events[0].event).toBe('/products/42');
    expect(events[0].properties.url).toBe('https://app.alitycs.test/products/42?utm_source=e2e&utm_campaign=launch');
    expect(events[0].context.utmSource).toBe('e2e');
    expect(events[0].context.utmCampaign).toBe('launch');
  });

  test('falls back to / when asPath is empty', async () => {
    routerState.asPath = '';

    const harness = await renderPagesProvider();
    await harness.flush();

    const events = harness.pageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('/');
    expect(events[0].properties.url).toBe('https://app.alitycs.test/');
  });

  test('fires on routeChangeComplete as the user navigates', async () => {
    const harness = await renderPagesProvider();
    await harness.flush();

    navigate('/cart');
    await harness.flush();

    navigate('/checkout?step=1');
    await harness.flush();

    expect(harness.pageEvents().map(event => event.event)).toEqual(['/', '/cart', '/checkout']);
    expect(harness.pageEvents()[2].properties.url).toContain('/checkout?step=1');
  });

  test('stops listening when the provider unmounts', async () => {
    const harness = await renderPagesProvider();
    await harness.flush();

    await rtl.act(async () => {
      rtl.cleanup();
    });
    expect(listenerCount('routeChangeComplete')).toBe(0);

    // Unmount drains whatever was queued (the shutdown contract), so pin the
    // post-unmount request count and assert navigating adds none.
    const requestsAfterUnmount = capture.requests.length;
    navigate('/gone');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(capture.requests.length).toBe(requestsAfterUnmount);
  });

  test('router="pages" skips detection entirely', async () => {
    // No #__next marker: detection alone would classify this as the App
    // Router (and crash on the real usePathname), which proves the override
    // actually bypasses it.
    document.getElementById('__next')?.remove();

    routerState.asPath = '/explicit';
    const harness = await renderPagesProvider({ router: 'pages' });
    await harness.flush();

    const events = harness.pageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('/explicit');
  });
});
