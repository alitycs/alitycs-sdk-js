import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AutoCapture } from '../../src/auto-capture';

describe('AutoCapture', () => {
  test('starts and stops cleanly', () => {
    const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];
    const ac = new AutoCapture((name, props) => tracked.push({ name, props }));

    // In non-browser environment (Bun), start() should be safe no-op
    ac.start();
    // start() checks for document, so isRunning depends on environment
    ac.stop();
    expect(ac.isRunning).toBe(false);
  });

  test('isRunning reflects state', () => {
    const ac = new AutoCapture(() => {});
    expect(ac.isRunning).toBe(false);
    // In non-browser env, start() won't set running=true (no document)
    ac.start();
    ac.stop();
    expect(ac.isRunning).toBe(false);
  });

  test('stop() removes all listeners', () => {
    const ac = new AutoCapture(() => {});
    ac.start();
    ac.stop();
    // After stop, calling stop again is safe
    ac.stop();
    expect(ac.isRunning).toBe(false);
  });
});

describe('AutoCapture pushState/replaceState tracking', () => {
  let originalWindow: any;
  let originalDocument: any;
  let originalHistory: any;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
    originalDocument = (globalThis as any).document;
    originalHistory = (globalThis as any).history;
    (globalThis as any).window = {
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      location: { href: 'http://localhost/', pathname: '/' },
    };
    (globalThis as any).document = {
      title: 'Test',
      referrer: '',
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    };
    (globalThis as any).history = {
      pushState: mock(() => {}),
      replaceState: mock(() => {}),
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).history = originalHistory;
  });

  test('patches history.pushState to fire $pageview', () => {
    const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];
    const ac = new AutoCapture((name, props) => tracked.push({ name, props }));

    ac.start();
    // Initial $pageview from start()
    expect(tracked.length).toBe(1);
    expect(tracked[0].name).toBe('$pageview');

    // Calling pushState should fire another $pageview
    history.pushState({}, '', '/new-page');
    expect(tracked.length).toBe(2);
    expect(tracked[1].name).toBe('$pageview');

    ac.stop();
  });

  test('patches history.replaceState to fire $pageview', () => {
    const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];
    const ac = new AutoCapture((name, props) => tracked.push({ name, props }));

    ac.start();
    expect(tracked.length).toBe(1);

    history.replaceState({}, '', '/replaced');
    expect(tracked.length).toBe(2);
    expect(tracked[1].name).toBe('$pageview');

    ac.stop();
  });

  test('restores originals on stop()', () => {
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;

    const ac = new AutoCapture(() => {});
    ac.start();

    // After start, history methods should be patched (different from originals)
    expect(history.pushState).not.toBe(originalPush);
    expect(history.replaceState).not.toBe(originalReplace);

    ac.stop();

    // After stop, originals should be restored
    expect(history.pushState).toBe(originalPush);
    expect(history.replaceState).toBe(originalReplace);
  });

  test('removes capture listeners with the same capture option', () => {
    const ac = new AutoCapture(() => {});
    ac.start();
    ac.stop();

    const calls = ((globalThis as any).document.removeEventListener as ReturnType<typeof mock>).mock.calls;
    const clickRemoval = calls.find((call: unknown[]) => call[0] === 'click');
    expect(clickRemoval?.[2]).toBe(true);
  });

  test('uses the page API once for the initial document and each SPA navigation', () => {
    const tracked: string[] = [];
    const pages: Array<Record<string, unknown>> = [];
    const ac = new AutoCapture(
      name => tracked.push(name),
      properties => pages.push(properties)
    );

    ac.start();
    history.pushState({}, '', '/pricing');
    history.replaceState({}, '', '/pricing?plan=pro');
    const popstateCall = ((globalThis as any).window.addEventListener as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => call[0] === 'popstate'
    );
    (popstateCall?.[1] as EventListener)(new Event('popstate'));

    expect(tracked).toEqual([]);
    expect(pages).toHaveLength(4);
    expect(pages[0]).toMatchObject({
      url: 'http://localhost/',
      hostname: 'localhost',
      path: '/',
      title: 'Test',
    });

    ac.stop();
  });

  test('captures interactive element clicks and ignores non-interactive targets', () => {
    const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];
    const ac = new AutoCapture((name, props) => tracked.push({ name, props }));
    ac.start();

    const clickHandler = ((globalThis as any).document.addEventListener as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => call[0] === 'click'
    )?.[1] as EventListener;
    clickHandler({
      target: {
        tagName: 'BUTTON',
        id: 'checkout',
        className: 'primary',
        textContent: '  Buy now  ',
        href: '',
        getAttribute: () => null,
      },
    } as unknown as Event);
    clickHandler({
      target: {
        tagName: 'DIV',
        id: '',
        className: '',
        textContent: 'Ignored',
        getAttribute: () => null,
      },
    } as unknown as Event);

    expect(tracked.filter(event => event.name === '$click')).toEqual([
      {
        name: '$click',
        props: {
          tag: 'BUTTON',
          id: 'checkout',
          classes: 'primary',
          text: 'Buy now',
          href: undefined,
        },
      },
    ]);

    ac.stop();
  });

  test('redacts obvious PII from captured $click hrefs', () => {
    const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];
    const ac = new AutoCapture((name, props) => tracked.push({ name, props }));
    ac.start();

    const clickHandler = ((globalThis as any).document.addEventListener as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) => call[0] === 'click'
    )?.[1] as EventListener;
    const hrefs: Array<string | undefined> = [];
    const capturingHandler = (target: { href: string }): void => {
      clickHandler({
        target: {
          tagName: 'A',
          id: '',
          className: '',
          textContent: 'Link',
          href: target.href,
          getAttribute: () => null,
        },
      } as unknown as Event);
      hrefs.push(tracked[tracked.length - 1]?.props.href as string | undefined);
    };

    // mailto targets carry a bare email address — dropped entirely.
    capturingHandler({ href: 'mailto:jane@example.com' });
    // Obvious email query parameters are stripped, the rest of the URL survives.
    capturingHandler({ href: 'https://example.test/search?email=jane@example.com&q=shoes&reply=me@corp.test' });
    // Ordinary URLs pass through untouched.
    capturingHandler({ href: 'https://example.test/pricing?plan=pro' });
    // Oversized hrefs are truncated.
    capturingHandler({ href: `https://example.test/path?blob=${'x'.repeat(2000)}` });

    expect(hrefs).toEqual([
      undefined,
      'https://example.test/search?q=shoes',
      'https://example.test/pricing?plan=pro',
      // 500-char cap minus the 31-char prefix.
      expect.stringMatching(/^https:\/\/example\.test\/path\?blob=x{469}$/),
    ]);
    ac.stop();
  });
});
