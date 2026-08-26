import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BrowserAlitycs } from '@alitycs/browser';
import { cleanup, render } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { AlitycsProvider } from '../src/provider';
import { captureClient, installDom, uninstallDom } from './helpers';

installDom();
afterAll(uninstallDom);
afterEach(async () => {
  cleanup();
  // Spies on BrowserAlitycs.init would otherwise accumulate calls across tests.
  mock.restore();
  // The registry defers shutdown by one tick so a synchronous remount reuses
  // the live client; let that timer run so every test starts with an empty
  // registry and its own freshly constructed client.
  await tick();
});

/** One macrotask — enough for the registry's deferred-shutdown timer to fire. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('AlitycsProvider', () => {
  test('constructs the client exactly once across re-renders', () => {
    const initSpy = spyOn(BrowserAlitycs, 'init');

    function Tree({ tick }: { tick: number }) {
      return createElement(
        AlitycsProvider,
        { apiKey: 'pk_once' },
        createElement('div', null, `tick-${tick}`)
      );
    }

    const { rerender, getByText } = render(createElement(Tree, { tick: 0 }));
    rerender(createElement(Tree, { tick: 1 }));
    rerender(createElement(Tree, { tick: 2 }));

    expect(getByText('tick-2')).toBeDefined();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0][0].apiKey).toBe('pk_once');
  });

  test('renders children unchanged', () => {
    const { container } = render(
      createElement(
        AlitycsProvider,
        { apiKey: 'pk_render' },
        createElement('section', { id: 'child' }, 'hello')
      )
    );
    expect(container.innerHTML).toBe('<section id="child">hello</section>');
  });

  test('hands the constructed client to useAlitycs consumers', () => {
    const probe = captureClient();
    const { container } = render(
      createElement(
        AlitycsProvider,
        { apiKey: 'pk_hands' },
        createElement(probe.Probe),
        createElement('p', null, 'sibling')
      )
    );
    expect(container.querySelector('p')).toBeDefined();
    expect(probe.get()).toBeInstanceOf(BrowserAlitycs);
  });

  test('calls shutdown() exactly once after the final unmount', async () => {
    const probe = captureClient();
    const { unmount } = render(
      createElement(AlitycsProvider, { apiKey: 'pk_shutdown' }, createElement(probe.Probe))
    );
    const client = probe.get()!;
    let shutdownCalls = 0;
    const originalShutdown = client.shutdown.bind(client);
    (client as unknown as Record<string, unknown>).shutdown = () => {
      shutdownCalls += 1;
      return originalShutdown();
    };

    unmount();
    // Shutdown is deferred one tick past unmount; let it fire and settle.
    await tick();

    expect(shutdownCalls).toBe(1);
    expect(client.isShutdown).toBe(true);
  });

  test('ignores prop changes after mount until remounted', () => {
    const initSpy = spyOn(BrowserAlitycs, 'init');
    const { rerender } = render(
      createElement(AlitycsProvider, { apiKey: 'pk_props', config: { debug: true } }, null)
    );
    rerender(
      createElement(AlitycsProvider, { apiKey: 'pk_props', config: { debug: false } }, null)
    );

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0][0].apiKey).toBe('pk_props');
    expect(initSpy.mock.calls[0][0].debug).toBe(true);
  });

  test('StrictMode mount/unmount/mount keeps the SAME live client', async () => {
    const initSpy = spyOn(BrowserAlitycs, 'init');
    const originalFetch = globalThis.fetch;
    const batches: Array<{ events?: Array<{ event: string }> }> = [];
    globalThis.fetch = mock(async (_url: any, init: any) => {
      batches.push(JSON.parse(String(init.body)));
      return new Response('OK', { status: 200 });
    }) as any;

    const probe = captureClient();

    const rendered = render(
      createElement(
        StrictMode,
        null,
        createElement(AlitycsProvider, { apiKey: 'pk_strict' }, createElement(probe.Probe))
      )
    );

    const client = probe.get()!;
    expect(client).toBeInstanceOf(BrowserAlitycs);
    // StrictMode double-invokes the state initialiser and runs its effect
    // setup/cleanup/setup cycle, but must construct exactly one client…
    expect(initSpy).toHaveBeenCalledTimes(1);
    // …and must not have shut it down during the simulated remount.
    expect(client.isShutdown).toBe(false);

    // The client survives the StrictMode cycle fully working: queue an event,
    // force a flush, and watch it reach the wire.
    client.track('strict_survivor', { n: 1 });
    await client.flush();
    expect(batches.flatMap(batch => batch.events ?? []).map(event => event.event)).toContain(
      'strict_survivor'
    );

    // Final unmount of the whole tree shuts the shared client down.
    const originalShutdown = client.shutdown.bind(client);
    let shutdownCalls = 0;
    (client as unknown as Record<string, unknown>).shutdown = () => {
      shutdownCalls += 1;
      return originalShutdown();
    };
    rendered.unmount();
    await tick();
    expect(shutdownCalls).toBe(1);
    expect(client.isShutdown).toBe(true);

    globalThis.fetch = originalFetch;
  });

  test('simultaneous providers with the same config share one client until all unmount', async () => {
    const initSpy = spyOn(BrowserAlitycs, 'init');
    const first = captureClient();
    const second = captureClient();

    const firstTree = render(
      createElement(AlitycsProvider, { apiKey: 'pk_shared' }, createElement(first.Probe))
    );
    const secondTree = render(
      createElement(AlitycsProvider, { apiKey: 'pk_shared' }, createElement(second.Probe))
    );

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(first.get()).toBe(second.get());

    firstTree.unmount();
    await tick();
    // One consumer left — the shared client must still be alive.
    expect(second.get()!.isShutdown).toBe(false);

    secondTree.unmount();
    await tick();
    expect(second.get()!.isShutdown).toBe(true);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  test('re-inits instead of handing out an instance shut down out-of-band', async () => {
    const probe = captureClient();
    render(createElement(AlitycsProvider, { apiKey: 'pk_dead' }, createElement(probe.Probe)));
    const dead = probe.get()!;
    await dead.shutdown();
    cleanup();
    await tick();

    const initSpy = spyOn(BrowserAlitycs, 'init');
    const next = captureClient();
    render(createElement(AlitycsProvider, { apiKey: 'pk_dead' }, createElement(next.Probe)));

    expect(next.get()).toBeInstanceOf(BrowserAlitycs);
    expect(next.get()).not.toBe(dead);
    expect(next.get()!.isShutdown).toBe(false);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});
