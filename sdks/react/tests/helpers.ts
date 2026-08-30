import type { BrowserAlitycs } from '@alitycs/browser';
import { Window } from 'happy-dom';
import { useAlitycs } from '../src/hooks';

/** A component that hands the context value to the test through a captured variable. */
export function captureClient(): { Probe: () => null; get: () => BrowserAlitycs | null } {
  let client: BrowserAlitycs | null = null;
  return {
    Probe: () => {
      client = useAlitycs();
      return null;
    },
    get: () => client,
  };
}

// RTL registers auto-cleanup at import time; we call cleanup() ourselves in a
// controlled order, so skip its hook.
process.env.RTL_SKIP_AUTO_CLEANUP = '1';

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
let savedDescriptors = new Map<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>();

/**
 * Installs happy-dom as the ambient DOM. Call once at module scope of a test
 * file and pair with `afterAll(uninstallDom)` — React 19's scheduler touches
 * `window` from late async callbacks, so the DOM must outlive individual
 * tests.
 */
export function installDom(): void {
  if (installed) return;
  installed = true;
  savedDescriptors = new Map(GLOBAL_KEYS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  const window = new Window({ url: 'https://app.alitycs.test/' });
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
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globals[key];
  }
  savedDescriptors.clear();
}

/**
 * Runs `fn` with every DOM global removed, restoring whatever was there
 * before. Server-rendering tests use this to prove the SDK never needs a DOM,
 * independent of which other test files ran first.
 */
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
