/**
 * Queue manager for storing method calls before SDK loads
 */

import type { QueuedCall } from './types';

export class CallQueue {
  private queue: QueuedCall[] = [];

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
