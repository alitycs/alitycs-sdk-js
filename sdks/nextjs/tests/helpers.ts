import { Window } from 'happy-dom';

// RTL registers global lifecycle hooks at import time when it sees a test
// runner; bun:test rejects a top-level beforeAll outside describe(). Tests
// call cleanup() explicitly where ordering matters, so skip the auto-hook.
process.env.RTL_SKIP_AUTO_CLEANUP = '1';

/**
 * DOM globals must exist before any renderer runs. Installed once per test
 * file and paired with `afterAll(uninstallDom)` — React 19's scheduler touches
 * `window` from late async callbacks, so the DOM must outlive individual
 * tests.
 *
 * Every react-family import in these tests (`react`, `react-dom/client`,
 * `@testing-library/react`) resolves through tsconfig `paths` to the physical
 * copy inside `sdks/react/node_modules` — the same copy `@alitycs/react`
 * resolves to. Bare specifiers here would load a second React and crash hook
 * dispatch with errors that look like SDK bugs.
 */
const GLOBAL_KEYS = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

let installed = false;

export function installDom(url = 'https://app.alitycs.test/'): void {
  if (installed) return;
  installed = true;
  const window = new Window({ url });
  const define = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  };
  define('window', window);
  define('document', window.document);
  define('navigator', window.navigator);
  define('location', window.location);
  define('history', window.history);
  define('screen', window.screen);
  define('IS_REACT_ACT_ENVIRONMENT', true);
}

export function uninstallDom(): void {
  if (!installed) return;
  installed = false;
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of GLOBAL_KEYS) {
    delete globals[key];
  }
}

/** Runs `fn` with every DOM global removed, restoring afterwards. */
export function withoutGlobals<T>(fn: () => T): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of GLOBAL_KEYS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    delete globals[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, descriptor] of saved.entries()) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globals[key];
      }
    }
  }
}

/** A tiny local batch receiver: records requests, answers 202. */
export interface CapturedRequest {
  headers: Record<string, string>;
  payload: unknown;
}

export interface CaptureServerHandle {
  url: string;
  requests: CapturedRequest[];
  stop(): Promise<void>;
}

export function startCaptureServer(): CaptureServerHandle {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const rawBody = await request.text();
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = undefined;
      }
      requests.push({ headers: Object.fromEntries(request.headers.entries()), payload });
      return Response.json({ accepted: true }, { status: 202 });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}/events`,
    requests,
    async stop() {
      await server.stop(true);
    },
  };
}
