/**
 * Integration tests for full snippet initialization
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Window } from 'happy-dom';

describe('Snippet Integration', () => {
  let window: Window;
  let document: Document;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // Create fresh DOM environment
    window = new Window({ settings: { disableJavaScriptFileLoading: true } });
    document = window.document as unknown as Document;
    (global as any).window = window;
    (global as any).document = document;

    // Mock console
    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    console.log = mock(() => {});
    console.warn = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    delete (global as any).window;
    delete (global as any).document;

    // Clear require cache to allow fresh imports
    delete require.cache[require.resolve('../src/snippet')];
  });

  test('should create global window.alitycs object', () => {
    // Setup script tag
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    // Import snippet (triggers initialization)
    require('../src/snippet');

    expect((window as any).alitycs).toBeDefined();
  });

  test('should initialize with config from script tag', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'init_test_key');
    script.setAttribute('data-debug', '');
    document.head.appendChild(script);

    require('../src/snippet');

    expect((window as any).alitycs._config).toBeDefined();
    expect((window as any).alitycs._config.apiKey).toBe('init_test_key');
    expect((window as any).alitycs._config.debug).toBe(true);
  });

  test('should have queue array on alitycs object', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    require('../src/snippet');

    expect((window as any).alitycs._queue).toBeDefined();
    expect(Array.isArray((window as any).alitycs._queue)).toBe(true);
  });

  test('should set loaded flag to false initially', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    require('../src/snippet');

    expect((window as any).alitycs.loaded).toBe(false);
  });

  test('should have track method', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    require('../src/snippet');

    expect(typeof (window as any).alitycs.track).toBe('function');
  });

  test('should have identify method', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    require('../src/snippet');

    expect(typeof (window as any).alitycs.identify).toBe('function');
  });

  test('should have page method', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    require('../src/snippet');

    expect(typeof (window as any).alitycs.page).toBe('function');
  });

  test('should queue calls before SDK loads', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    require('../src/snippet');

    (window as any).alitycs.track('event1', { foo: 'bar' });
    (window as any).alitycs.identify('user123');

    expect((window as any).alitycs._queue.length).toBe(2);
  });

  test('should auto-track page view when autoTrack is true', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'true');
    document.head.appendChild(script);

    require('../src/snippet');

    // Should have one page() call in queue
    expect((window as any).alitycs._queue.length).toBeGreaterThan(0);
    expect((window as any).alitycs._queue[0].method).toBe('page');
  });

  test('should NOT auto-track when autoTrack is false', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    require('../src/snippet');

    expect((window as any).alitycs._queue.length).toBe(0);
  });

  test('should log initialization in debug mode', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-debug', '');
    document.head.appendChild(script);

    require('../src/snippet');

    expect(console.warn).toHaveBeenCalledWith('[Alitycs] Snippet initialized');
  });

  test('should preserve existing window.alitycs queue', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    // Prevent performLoad from creating a real script element
    (window as any).AlitycsSDK = {};

    // Pre-buffer calls in object format
    (window as any).alitycs = {
      _queue: [
        { method: 'track', args: ['event1', { foo: 'bar' }] },
        { method: 'identify', args: ['user123'] },
      ],
    };

    require('../src/snippet');

    // Pre-buffered calls should be preserved in the new stub's queue
    expect((window as any).alitycs._queue.length).toBe(2);
    expect((window as any).alitycs._queue[0].method).toBe('track');
    expect((window as any).alitycs._queue[0].args).toEqual(['event1', { foo: 'bar' }]);
    expect((window as any).alitycs._queue[1].method).toBe('identify');
    expect((window as any).alitycs._queue[1].args).toEqual(['user123']);
  });

  test('should not reinitialize if already loaded', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    // First initialization
    (window as any).alitycs = {
      loaded: true,
      _config: { apiKey: 'existing' },
    };

    require('../src/snippet');

    // Should not override existing config
    expect((window as any).alitycs._config.apiKey).toBe('existing');
  });

  test('should be chainable', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    require('../src/snippet');

    const result = (window as any).alitycs.track('event1').identify('user1').page('Home');

    expect(result).toBe((window as any).alitycs);
    expect((window as any).alitycs._queue.length).toBe(3);
  });

  test('should support main function call syntax', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    require('../src/snippet');

    (window as any).alitycs('track', 'custom_event', { prop: 'value' });

    expect((window as any).alitycs._queue.length).toBe(1);
    expect((window as any).alitycs._queue[0].method).toBe('track');
    expect((window as any).alitycs._queue[0].args).toEqual(['custom_event', { prop: 'value' }]);
  });

  test('should preserve queue format for array-style calls', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    // Prevent performLoad from creating a real script element
    (window as any).AlitycsSDK = {};

    // Pre-buffer calls in array format
    (window as any).alitycs = {
      _queue: [
        ['track', 'event1', { foo: 'bar' }],
        ['identify', 'user123'],
      ],
    };

    require('../src/snippet');

    // Array-style calls should be converted to { method, args } format
    expect((window as any).alitycs._queue.length).toBe(2);
    expect((window as any).alitycs._queue[0].method).toBe('track');
    expect((window as any).alitycs._queue[0].args).toEqual(['event1', { foo: 'bar' }]);
    expect((window as any).alitycs._queue[1].method).toBe('identify');
    expect((window as any).alitycs._queue[1].args).toEqual(['user123']);
  });

  test('should work with minimal configuration', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'minimal_key');
    document.head.appendChild(script);

    require('../src/snippet');

    expect((window as any).alitycs).toBeDefined();
    expect((window as any).alitycs._config.apiKey).toBe('minimal_key');
    expect(typeof (window as any).alitycs.track).toBe('function');
  });

  test('should work with full configuration', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'full_key');
    script.setAttribute('data-sdk-url', 'https://custom.com/sdk.js');
    script.setAttribute('data-endpoint', 'https://api.custom.com/events');
    script.setAttribute('data-auto-track', 'false');
    script.setAttribute('data-debug', '');
    document.head.appendChild(script);

    require('../src/snippet');

    const config = (window as any).alitycs._config;

    expect(config.apiKey).toBe('full_key');
    expect(config.sdkUrl).toBe('https://custom.com/sdk.js');
    expect(config.endpoint).toBe('https://api.custom.com/events');
    expect(config.autoTrack).toBe(false);
    expect(config.debug).toBe(true);
  });
});
