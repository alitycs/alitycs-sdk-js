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
});
