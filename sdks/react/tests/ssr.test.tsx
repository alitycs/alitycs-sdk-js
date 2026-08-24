import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { act } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { useAlitycs, useAlitycsPageView, useTrack } from '../src/hooks';
import { AlitycsProvider } from '../src/provider';
import { installDom, uninstallDom, withoutGlobals } from './helpers';

// The hydration test below renders client-side React, which needs a DOM for
// the lifetime of this file (React 19's scheduler touches `window` from late
// async callbacks). The pure-SSR tests remove those globals around themselves
// via withoutGlobals(), so they prove server rendering never needs one
// regardless of execution order.
installDom();
afterAll(uninstallDom);

function ClientProbe(): React.ReactElement {
  const client = useAlitycs();
  const track = useTrack();
  // Both must be safe to touch while rendering on the server.
  track('ssr_render_event', { n: 1 });
  return createElement('span', null, `client:${client === null ? 'null' : 'present'}`);
}

describe('SSR safety', () => {
  test('no window or document exists while server rendering', () => {
    withoutGlobals(() => {
      expect(typeof window).toBe('undefined');
      expect(typeof document).toBe('undefined');
    });
  });

  test('server rendering outputs children unchanged and constructs nothing', () => {
    const html = withoutGlobals(() =>
      renderToStaticMarkup(
        createElement(
          AlitycsProvider,
          { apiKey: 'pk_test', config: { autoCapture: true } },
          createElement('section', null, 'hello'),
          createElement(ClientProbe)
        )
      )
    );
    expect(html).toBe('<section>hello</section><span>client:null</span>');
  });

  test('page-view hook renders without touching the DOM', () => {
    function Page(): React.ReactElement {
      useAlitycsPageView('/home');
      return createElement('p', null, 'page');
    }
    const html = withoutGlobals(() =>
      renderToStaticMarkup(
        createElement(AlitycsProvider, { apiKey: 'pk_test' }, createElement(Page))
      )
    );
    expect(html).toBe('<p>page</p>');
  });

  test('hydrates client-side output without a mismatch warning', async () => {
    const tree = createElement(
      AlitycsProvider,
      { apiKey: 'pk_test' },
      createElement('main', null, 'content')
    );

    // Server HTML first — rendered with no DOM present.
    const serverHtml = withoutGlobals(() => renderToString(tree));

    const { hydrateRoot } = await import('react-dom/client');
    const container = (globalThis as unknown as { document: Document }).document.createElement(
      'div'
    );
    container.innerHTML = serverHtml;

    const errors: unknown[][] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    // Hydrate and let React finish before tearing down — an unmount during
    // hydration is a legitimate "early update" warning, not what we're testing.
    let root: { unmount(): void } | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree);
    });
    await act(async () => {
      root?.unmount();
    });

    errorSpy.mockRestore();

    const flattened = JSON.stringify(errors).toLowerCase();
    expect(flattened).not.toContain('mismatch');
    expect(flattened).not.toContain('hydrat');
    expect(errors.length).toBe(0);
  });
});
