/**
 * Unit tests for browser snippet
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CallQueue } from '../src/queue';
import { createStub } from '../src/stub';
import type { SnippetConfig } from '../src/types';

describe('CallQueue', () => {
  let queue: CallQueue;

  beforeEach(() => {
    queue = new CallQueue();
  });

  test('should push calls to queue', () => {
    queue.push('track', ['event1', { foo: 'bar' }]);
    expect(queue.size()).toBe(1);
  });

  test('should store method, args, and timestamp', () => {
    queue.push('track', ['event1']);
    const calls = queue.getAll();

    expect(calls[0].method).toBe('track');
    expect(calls[0].args).toEqual(['event1']);
    expect(calls[0].timestamp).toBeGreaterThan(0);
  });

  test('should clear queue', () => {
    queue.push('track', ['event1']);
    queue.push('track', ['event2']);
    expect(queue.size()).toBe(2);

    queue.clear();
    expect(queue.size()).toBe(0);
  });
});

describe('createStub', () => {
  let queue: CallQueue;
  let config: SnippetConfig;

  beforeEach(() => {
    queue = new CallQueue();
    config = {
      apiKey: 'test_key',
      autoTrack: true,
      debug: false,
    };
  });

  test('should create stub with queue', () => {
    const stub = createStub(queue, config);

    expect(stub).toBeDefined();
    expect(stub._queue).toBeDefined();
    expect(stub._config).toEqual(config);
    expect(stub.loaded).toBe(false);
  });

  test('should queue calls via main function', () => {
    const stub = createStub(queue, config);
    stub('track', 'event1', { foo: 'bar' });

    expect(queue.size()).toBe(1);
    expect(queue.getAll()[0].method).toBe('track');
    expect(queue.getAll()[0].args).toEqual(['event1', { foo: 'bar' }]);
  });

  test('should queue calls via helper methods', () => {
    const stub = createStub(queue, config);

    stub.track('event1', { prop: 'value' });
    stub.identify('user123', { email: 'test@example.com' });
    stub.page('Home', { path: '/' });

    expect(queue.size()).toBe(3);
    expect(queue.getAll()[0].method).toBe('track');
    expect(queue.getAll()[1].method).toBe('identify');
    expect(queue.getAll()[2].method).toBe('page');
  });

  test('should be chainable', () => {
    const stub = createStub(queue, config);

    const result = stub.track('event1').identify('user1').page('Home');

    expect(result).toBe(stub);
    expect(queue.size()).toBe(3);
  });

  test('should have all standard methods', () => {
    const stub = createStub(queue, config);

    expect(typeof stub.track).toBe('function');
    expect(typeof stub.identify).toBe('function');
    expect(typeof stub.page).toBe('function');
    expect(typeof stub.setGlobalProperties).toBe('function');
    expect(typeof stub.removeGlobalProperties).toBe('function');
    expect(typeof stub.clearGlobalProperties).toBe('function');
  });

  test('should queue method calls without arguments', () => {
    const stub = createStub(queue, config);
    stub.page();

    expect(queue.size()).toBe(1);
    expect(queue.getAll()[0].args).toEqual([]);
  });
});

describe('Snippet Module Exports', () => {
  test('should export CallQueue', () => {
    const { CallQueue } = require('../src/queue');
    expect(CallQueue).toBeDefined();
  });

  test('should export createStub', () => {
    const { createStub } = require('../src/stub');
    expect(createStub).toBeDefined();
  });

  test('should export SDKLoader', () => {
    const { SDKLoader } = require('../src/loader');
    expect(SDKLoader).toBeDefined();
  });

  test('should export parseScriptConfig', () => {
    const { parseScriptConfig } = require('../src/config');
    expect(parseScriptConfig).toBeDefined();
  });
});
