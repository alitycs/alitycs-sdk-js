import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { BrowserAlitycs, type EventOptions } from '@alitycs/browser';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { useAlitycs, useAlitycsPageView, useTrack, type TrackFn } from '../src/hooks';
import { AlitycsProvider } from '../src/provider';
import { installDom, uninstallDom } from './helpers';

installDom();
afterAll(uninstallDom);
afterEach(cleanup);

/**
 * Builds provider trees whose FIRST child is always the recorder — siblings
 * keep their positions across rerenders, so a consumer never remounts just
 * because the tree around it changed.
 */
function makeHarness(instrument: (client: BrowserAlitycs) => void): {
  tree: (children?: ReactNode) => ReactElement;
} {
  let installed = false;
  function Recorder(): null {
    const client = useAlitycs();
    if (client && !installed) {
      installed = true;
      instrument(client);
    }
    return null;
  }
  return {
    tree: (children?: ReactNode) =>
      createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(Recorder), children),
  };
}

/**
 * Renders `<Provider>{children}</Provider>` with an instrumenting component as
 * the first child. Sibling components render in tree order within the same
 * commit, so recorders installed during `instrument()`'s render are in place
 * before any later sibling calls the hook methods.
 */
function renderWithRecorder(
  instrument: (client: BrowserAlitycs) => void,
  children?: ReactNode
): ReturnType<typeof render> {
  let installed = false;
  function Recorder(): null {
    const client = useAlitycs();
    if (client && !installed) {
      installed = true;
      instrument(client);
    }
    return null;
  }
  return render(
    createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(Recorder), children)
  );
}

describe('useAlitycs', () => {
  test('throws a useful error outside a provider', () => {
    function Bare(): null {
      useAlitycs();
      return null;
    }
    expect(() => render(createElement(Bare))).toThrow('AlitycsProvider');
  });

  test('returns the same client to every consumer', () => {
    const seen: Array<BrowserAlitycs | null> = [];

    function Consumer(): null {
      seen.push(useAlitycs());
      return null;
    }

    const { tree } = makeHarness(() => undefined);
    render(tree([createElement(Consumer, { key: 'a' }), createElement(Consumer, { key: 'b' })]));

    expect(seen.length).toBe(2);
    expect(seen[0]).toBeInstanceOf(BrowserAlitycs);
    expect(seen[0]).toBe(seen[1]);
  });
});
describe('useTrack', () => {
  test('returns a referentially stable function across re-renders', () => {
    let latest: TrackFn | undefined;
    let first: TrackFn | undefined;

    function Consumer({ tick }: { tick: number }): ReactElement {
      const track = useTrack();
      if (!first) first = track;
      latest = track;
      return createElement('div', null, `tick-${tick}`);
    }

    const { rerender, getByText } = render(
      createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(Consumer, { tick: 0 }))
    );
    rerender(
      createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(Consumer, { tick: 1 }))
    );
    rerender(
      createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(Consumer, { tick: 2 }))
    );

    expect(getByText('tick-2')).toBeDefined();
    expect(first).toBeDefined();
    expect(latest).toBe(first);
  });

  test('delegates name, properties, and options to the client', () => {
    const delegated: Array<[string, Record<string, unknown>?, EventOptions?]> = [];

    function Consumer(): null {
      const track = useTrack();
      track('button_clicked', { n: 1 }, { dedupeKey: 'd-1' });
      return null;
    }

    const { tree } = makeHarness((client) => {
      (client as unknown as Record<string, unknown>).track = (
        name: string,
        properties?: Record<string, unknown>,
        options?: EventOptions
      ) => {
        delegated.push([name, properties, options]);
      };
    });
    render(tree(createElement(Consumer)));

    expect(delegated).toEqual([['button_clicked', { n: 1 }, { dedupeKey: 'd-1' }]]);
  });

  test('events queued through useTrack reach the wire', async () => {
    const sent: Array<{ events?: Array<{ event: string; properties?: Record<string, unknown> }> }> =
      [];
    let resolveRequest!: () => void;
    const requestReceived = new Promise<void>(resolve => {
      resolveRequest = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        sent.push(await request.json());
        resolveRequest();
        return Response.json({ accepted: true });
      },
    });

    try {
      function Consumer(): null {
        const track = useTrack();
        track('queued_event', { n: 7 });
        return null;
      }

      render(
        createElement(
          AlitycsProvider,
          {
            apiKey: 'pk_test',
            config: {
              endpoint: `http://localhost:${server.port}/events`,
              // Send-on-enqueue keeps the test free of flush timing.
              batching: false,
              debug: false,
            },
          },
          createElement(Consumer)
        )
      );

      await requestReceived;

      expect(sent.length).toBe(1);
      expect(sent[0].events?.[0]?.event).toBe('queued_event');
      // serializeProperties stringifies scalar values for the wire.
      expect(sent[0].events?.[0]?.properties?.n).toBe('7');
    } finally {
      server.stop(true);
      cleanup();
    }
  });
});

describe('useAlitycsPageView', () => {
  test('fires page() on mount and on pathname change, not on unrelated renders', () => {
    const pageCalls: Array<[string, Record<string, unknown>?]> = [];

    function Page({ path, props }: { path: string; props?: Record<string, unknown> }): null {
      useAlitycsPageView(path, props);
      return null;
    }

    const pageEl = (path: string, props?: Record<string, unknown>) =>
      createElement(Page, { path, props });

    const { tree } = makeHarness((client) => {
      (client as unknown as Record<string, unknown>).page = (
        name?: string,
        properties?: Record<string, unknown>
      ) => {
        pageCalls.push([name as string, properties]);
      };
    });

    const { rerender } = render(tree(pageEl('/home', { source: 'test' })));

    expect(pageCalls).toEqual([['/home', { source: 'test' }]]);

    // Properties alone changed — no re-fire.
    rerender(tree(pageEl('/home', { source: 'changed' })));
    expect(pageCalls).toEqual([['/home', { source: 'test' }]]);

    // Path change re-fires.
    rerender(tree(pageEl('/pricing', { source: 'changed' })));
    expect(pageCalls).toEqual([
      ['/home', { source: 'test' }],
      ['/pricing', { source: 'changed' }],
    ]);
  });

  test('throws outside a provider', () => {
    function Bare({ path }: { path: string }): null {
      useAlitycsPageView(path);
      return null;
    }
    expect(() => render(createElement(Bare, { path: '/' }))).toThrow('AlitycsProvider');
  });
});
