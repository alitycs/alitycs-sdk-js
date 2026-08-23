/**
 * Queue manager for storing method calls before SDK loads
 */

import type { QueuedCall } from './types';

export class CallQueue {
  private queue: QueuedCall[];

  constructor() {
    this.queue = [];
  }

  /**
   * Add a call to the queue
   */
  push(method: string, args: any[]): void {
    this.queue.push({
      method,
      args,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all queued calls
   */
  getAll(): QueuedCall[] {
    return this.queue;
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }
}

/**
 * Replay calls buffered by an inline bootstrap before this snippet loads.
 */
export function replayBufferedCalls(queue: CallQueue, bufferedCalls: unknown): boolean {
  if (!Array.isArray(bufferedCalls)) return false;

  for (const call of bufferedCalls) {
    if (Array.isArray(call) && typeof call[0] === 'string') {
      queue.push(call[0], call.slice(1));
      continue;
    }

    if (call && typeof call === 'object' && 'method' in call && typeof call.method === 'string') {
      const args = 'args' in call && Array.isArray(call.args) ? call.args : [];
      queue.push(call.method, args);
    }
  }

  return bufferedCalls.length > 0;
}
