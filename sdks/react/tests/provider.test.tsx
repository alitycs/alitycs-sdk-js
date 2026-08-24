import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { BrowserAlitycs } from '@alitycs/browser';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { AlitycsProvider } from '../src/provider';
import { captureClient, installDom, uninstallDom } from './helpers';

installDom();
afterAll(uninstallDom);
afterEach(() => {
  cleanup();
  // Spies on BrowserAlitycs.init would otherwise accumulate calls across tests.
  mock.restore();
});

describe('AlitycsProvider', () => {
  test('constructs the client exactly once across re-renders', () => {
    const initSpy = spyOn(BrowserAlitycs, 'init');

    function Tree({ tick }: { tick: number }) {
      return createElement(
        AlitycsProvider,
        { apiKey: 'pk_test' },
        createElement('div', null, `tick-${tick}`)
      );
    }

    const { rerender, getByText } = render(createElement(Tree, { tick: 0 }));
    rerender(createElement(Tree, { tick: 1 }));
    rerender(createElement(Tree, { tick: 2 }));

    expect(getByText('tick-2')).toBeDefined();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0][0].apiKey).toBe('pk_test');
  });

  test('renders children unchanged', () => {
    const { container } = render(
      createElement(
        AlitycsProvider,
        { apiKey: 'pk_test' },
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
        { apiKey: 'pk_test' },
        createElement(probe.Probe),
        createElement('p', null, 'sibling')
      )
    );
    expect(container.querySelector('p')).toBeDefined();
    expect(probe.get()).toBeInstanceOf(BrowserAlitycs);
  });

  test('calls shutdown() exactly once on unmount', async () => {
    const probe = captureClient();
    const { unmount } = render(
      createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(probe.Probe))
    );
    const client = probe.get()!;
    let shutdownCalls = 0;
    const originalShutdown = client.shutdown.bind(client);
    (client as unknown as Record<string, unknown>).shutdown = () => {
      shutdownCalls += 1;
      return originalShutdown();
    };

    unmount();
    // Let the unmount effect's async work settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await originalShutdown();

    expect(shutdownCalls).toBe(1);
  });

  test('ignores prop changes after mount until remounted', () => {
    const initSpy = spyOn(BrowserAlitycs, 'init');
    const { rerender } = render(
      createElement(AlitycsProvider, { apiKey: 'pk_first', config: { debug: true } }, null)
    );
    rerender(
      createElement(AlitycsProvider, { apiKey: 'pk_second', config: { debug: false } }, null)
    );

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0][0].apiKey).toBe('pk_first');
    expect(initSpy.mock.calls[0][0].debug).toBe(true);
  });
});
