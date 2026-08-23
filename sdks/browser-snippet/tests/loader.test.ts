/**
 * Tests for SDKLoader
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { SDKLoader } from '../src/loader';
import type { SnippetConfig } from '../src/types';

describe('SDKLoader', () => {
  let window: Window;
  let document: Document;
  let loader: SDKLoader;
  let config: SnippetConfig;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // Create DOM environment
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

    config = {
      apiKey: 'test_key',
      sdkUrl: 'https://cdn.alitycs.com/sdk.js',
      autoTrack: true,
      debug: false,
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    delete (global as any).window;
    delete (global as any).document;
  });

  describe('setup()', () => {
    test('should not load immediately on setup', () => {
      loader = new SDKLoader(config);

      const loadSpy = spyOn(loader, 'load');
      loader.setup();

      // Should not load immediately, will wait for interaction/idle/timeout
      expect(loadSpy).not.toHaveBeenCalled();
    });

    test('should setup interaction event listeners', () => {
      loader = new SDKLoader(config);

      const addEventListenerSpy = spyOn(document, 'addEventListener');
      loader.setup();

      // Should add listeners for mousedown, touchstart, keydown, scroll
      expect(addEventListenerSpy).toHaveBeenCalledTimes(4);
    });

    test('loads immediately when hasQueuedCalls is true', () => {
      loader = new SDKLoader(config);

      // Mock load to prevent actual script loading
      let loadCalled = 0;
      (loader as any).load = () => {
        loadCalled++;
      };
      loader.setup(true);

      expect(loadCalled).toBe(1);
    });

    test('uses lazy strategies when hasQueuedCalls is false', () => {
      loader = new SDKLoader(config);

      const loadSpy = spyOn(loader, 'load');
      const addEventListenerSpy = spyOn(document, 'addEventListener');
      loader.setup(false);

      // Should not load immediately
      expect(loadSpy).not.toHaveBeenCalled();
      // Should set up interaction listeners
      expect(addEventListenerSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe('load()', () => {
    test('should set loading flag during load', async () => {
      loader = new SDKLoader(config);

      // Mock performLoad to return pending promise
      let resolveLoad: any;
      const loadPromise = new Promise<void>(resolve => {
        resolveLoad = resolve;
      });

      (loader as any).performLoad = () => loadPromise;

      const loadingPromise = loader.load();

      // Should be loading
      expect((loader as any).loading).toBe(true);
      expect((loader as any).loaded).toBe(false);

      resolveLoad();
      await loadingPromise;

      // Should be loaded
      expect((loader as any).loading).toBe(false);
      expect((loader as any).loaded).toBe(true);
    });

    test('should return same promise for concurrent calls', async () => {
      loader = new SDKLoader(config);
      (loader as any).performLoad = () => Promise.resolve();

      const p1 = loader.load();
      const p2 = loader.load();

      await Promise.all([p1, p2]);
      expect(loader.isLoaded()).toBe(true);
    });

    test('should not reload if already loaded', async () => {
      loader = new SDKLoader(config);
      let callCount = 0;
      (loader as any).performLoad = () => {
        callCount++;
        return Promise.resolve();
      };

      await loader.load();
      await loader.load();

      expect(callCount).toBe(1);
    });

    test('should log success message in debug mode', async () => {
      config.debug = true;
      loader = new SDKLoader(config);
      (loader as any).performLoad = () => Promise.resolve();

      await loader.load();

      expect(console.warn).toHaveBeenCalledWith('[Alitycs] SDK loaded successfully');
    });

    test('should handle load errors', async () => {
      loader = new SDKLoader(config);

      // Mock performLoad to reject
      (loader as any).performLoad = () => Promise.reject(new Error('Load failed'));

      await expect(loader.load()).rejects.toThrow('Load failed');

      expect(console.error).toHaveBeenCalled();
      expect((loader as any).loaded).toBe(false);
      expect((loader as any).loading).toBe(false);
    });
  });

  describe('performLoad()', () => {
    // Helper: mock document.createElement to return a div for 'script' tags,
    // avoiding happy-dom's auto-load behavior on real script elements.
    function mockScriptCreation() {
      const mockScript = document.createElement('div') as any;
      const origCreateElement = document.createElement.bind(document);
      spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        if (tag === 'script') return mockScript;
        return origCreateElement(tag);
      }) as any);
      return mockScript;
    }

    test('should create script with correct attributes', async () => {
      loader = new SDKLoader(config);
      const mockScript = mockScriptCreation();

      const promise = (loader as any).performLoad();

      expect(mockScript.src).toBe('https://cdn.alitycs.com/sdk.js');
      expect(mockScript.async).toBe(true);
      expect(mockScript.defer).toBe(true);

      mockScript.onload();
      await promise;
    });

    test('should set data attributes from config', async () => {
      config.endpoint = 'https://api.example.com/events';
      config.autoCapture = true;
      config.debug = true;
      loader = new SDKLoader(config);
      const mockScript = mockScriptCreation();

      const promise = (loader as any).performLoad();

      expect(mockScript.getAttribute('data-api-key')).toBe('test_key');
      expect(mockScript.getAttribute('data-endpoint')).toBe('https://api.example.com/events');
      expect(mockScript.getAttribute('data-auto-capture')).toBe('true');
      expect(mockScript.getAttribute('data-debug')).toBe('true');

      mockScript.onload();
      await promise;
    });

    test('should reject on script error', async () => {
      loader = new SDKLoader(config);
      const mockScript = mockScriptCreation();

      const promise = (loader as any).performLoad();
      mockScript.onerror();

      await expect(promise).rejects.toThrow('Failed to load SDK from:');
    });

    test('should resolve immediately if AlitycsSDK on window', async () => {
      (window as any).AlitycsSDK = {};
      loader = new SDKLoader(config);

      await (loader as any).performLoad();

      // No script should have been created with the SDK URL
      const scripts = document.getElementsByTagName('script');
      let found = false;
      for (let i = 0; i < scripts.length; i++) {
        if (scripts[i].src === config.sdkUrl) found = true;
      }
      expect(found).toBe(false);

      delete (window as any).AlitycsSDK;
    });
  });

  describe('isLoaded()', () => {
    test('should return false initially', () => {
      loader = new SDKLoader(config);
      expect(loader.isLoaded()).toBe(false);
    });

    test('should return true after loading', async () => {
      loader = new SDKLoader(config);
      (loader as any).performLoad = () => Promise.resolve();

      expect(loader.isLoaded()).toBe(false);
      await loader.load();
      expect(loader.isLoaded()).toBe(true);
    });
  });

  describe('event listener cleanup', () => {
    test('should remove interaction listeners after load', async () => {
      loader = new SDKLoader(config);
      loader.setup(false);

      const removeListenerSpy = spyOn(document, 'removeEventListener');
      (loader as any).performLoad = () => Promise.resolve();

      await loader.load();

      expect(removeListenerSpy).toHaveBeenCalledTimes(4);
    });

    test('should clear listeners array after load', async () => {
      loader = new SDKLoader(config);
      loader.setup(false);

      expect((loader as any).listeners.length).toBe(4);

      (loader as any).performLoad = () => Promise.resolve();
      await loader.load();

      expect((loader as any).listeners.length).toBe(0);
    });
  });

  describe('lazy loading strategies', () => {
    test('should load on mousedown event', () => {
      loader = new SDKLoader(config);
      const loadSpy = spyOn(loader, 'load').mockImplementation(() => Promise.resolve());
      loader.setup(false);

      document.dispatchEvent(new (window as any).Event('mousedown'));

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    test('should load on touchstart event', () => {
      loader = new SDKLoader(config);
      const loadSpy = spyOn(loader, 'load').mockImplementation(() => Promise.resolve());
      loader.setup(false);

      document.dispatchEvent(new (window as any).Event('touchstart'));

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    test('should load on keydown event', () => {
      loader = new SDKLoader(config);
      const loadSpy = spyOn(loader, 'load').mockImplementation(() => Promise.resolve());
      loader.setup(false);

      document.dispatchEvent(new (window as any).Event('keydown'));

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    test('should load on scroll event', () => {
      loader = new SDKLoader(config);
      const loadSpy = spyOn(loader, 'load').mockImplementation(() => Promise.resolve());
      loader.setup(false);

      document.dispatchEvent(new (window as any).Event('scroll'));

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    test('should only trigger load once across multiple events', () => {
      loader = new SDKLoader(config);
      const loadSpy = spyOn(loader, 'load').mockImplementation(() => Promise.resolve());
      loader.setup(false);

      document.dispatchEvent(new (window as any).Event('mousedown'));
      document.dispatchEvent(new (window as any).Event('keydown'));

      expect(loadSpy).toHaveBeenCalledTimes(1);
    });

    test('should use setTimeout fallback when no requestIdleCallback', () => {
      delete (window as any).requestIdleCallback;
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

      loader = new SDKLoader(config);
      loader.setup(false);

      const timeouts = setTimeoutSpy.mock.calls.map((c: any) => c[1]);
      expect(timeouts).toContain(3000);
      expect(timeouts).toContain(5000);
    });

    test('idle and timeout callbacks request loading when the SDK stays pending', () => {
      const idleCallbacks: Array<() => void> = [];
      const timeoutCallbacks: Array<() => void> = [];
      const requestIdleCallbackMock = mock((callback: () => void) => {
        idleCallbacks.push(callback);
        return 1;
      });
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
        timeoutCallbacks.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      (window as any).requestIdleCallback = requestIdleCallbackMock;
      (global as any).requestIdleCallback = requestIdleCallbackMock;
      loader = new SDKLoader(config);
      const loadSpy = spyOn(loader, 'load').mockResolvedValue();

      try {
        loader.setup(false);
        idleCallbacks.forEach(callback => callback());
        timeoutCallbacks.forEach(callback => callback());
      } finally {
        setTimeoutSpy.mockRestore();
        delete (global as any).requestIdleCallback;
      }

      expect(loadSpy).toHaveBeenCalledTimes(2);
    });
  });
});
