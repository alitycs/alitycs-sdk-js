/**
 * Stub analytics object that queues method calls
 */

import type { AlitycsStub, SnippetConfig } from './types';
import { CallQueue } from './queue';

/**
 * Create a stub analytics object that queues calls
 */
export function createStub(queue: CallQueue, config: SnippetConfig): AlitycsStub {
  // Main function that handles generic method calls
  const stub = function (method: string, ...args: any[]): AlitycsStub {
    queue.push(method, args);
    return stub as AlitycsStub;
  } as AlitycsStub;

  // Predefined methods for better DX
  const methods = [
    'track',
    'captureError',
    'identify',
    'reset',
    'page',
    'setGlobalProperties',
    'removeGlobalProperties',
    'clearGlobalProperties',
  ];

  methods.forEach(method => {
    (stub as any)[method] = (...args: any[]) => {
      queue.push(method, args);
      return stub;
    };
  });

  // Attach queue and config (for debugging and SDK initialization)
  stub._queue = queue.getAll();
  stub._config = config;
  stub.loaded = false;

  return stub;
}
