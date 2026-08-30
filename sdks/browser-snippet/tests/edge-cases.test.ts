/**
 * Edge cases and error scenario tests
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { SDKLoader } from '../src/loader';
import { CallQueue } from '../src/queue';
import type { SnippetConfig } from '../src/types';

const EXPECTED_DEFAULT_SDK_URL = 'https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.3/dist/browser.min.js';

describe('Edge Cases and Error Scenarios', () => {
  let window: Window;
  let document: Document;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    window = new Window({ settings: { disableJavaScriptFileLoading: true } });
    document = window.document as unknown as Document;
    (global as any).window = window;
    (global as any).document = document;

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
  });

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

  describe('Missing or Invalid Configuration', () => {
    test('should handle missing API key', () => {
      const script = document.createElement('script');
      script.src = 'https://cdn.example.com/alitycs/snippet.js';
      // No data-api-key attribute
      document.head.appendChild(script);

      const { parseScriptConfig } = require('../src/config');
      const config = parseScriptConfig();

      expect(config.apiKey).toBe('');
      expect(console.error).toHaveBeenCalledWith('[Alitycs] Missing data-api-key attribute');
    });

    test('should handle empty API key', () => {
      const script = document.createElement('script');
      script.setAttribute('data-api-key', '');
      document.head.appendChild(script);

      const { parseScriptConfig } = require('../src/config');
      const config = parseScriptConfig();

      expect(config.apiKey).toBe('');
      expect(console.error).toHaveBeenCalled();
    });

    test('should handle whitespace-only API key', () => {
      const script = document.createElement('script');
      script.setAttribute('data-api-key', '   ');
      document.head.appendChild(script);

      const { parseScriptConfig } = require('../src/config');
      const config = parseScriptConfig();

      expect(config.apiKey).toBe('   ');
    });

    test('should use defaults for missing optional config', () => {
      const script = document.createElement('script');
      script.setAttribute('data-api-key', 'test_key');
      // No other attributes
      document.head.appendChild(script);

      const { parseScriptConfig } = require('../src/config');
      const config = parseScriptConfig();

      expect(config.sdkUrl).toBe(EXPECTED_DEFAULT_SDK_URL);
      expect(config.autoTrack).toBe(true);
      expect(config.debug).toBe(false);
      expect(config.endpoint).toBeUndefined();
    });
  });

  describe('SDK Load Failures', () => {
    test('should handle network error', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);
      (loader as any).performLoad = () => Promise.reject(new Error('Network error'));

      await expect(loader.load()).rejects.toThrow('Network error');
      expect(loader.isLoaded()).toBe(false);
      expect((loader as any).loading).toBe(false);
      expect((loader as any).loadPromise).toBeNull();
    });

    test('should allow retry after failure', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);

      let callCount = 0;
      (loader as any).performLoad = () => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('First failure'));
        return Promise.resolve();
      };

      await expect(loader.load()).rejects.toThrow('First failure');
      await loader.load();
      expect(loader.isLoaded()).toBe(true);
    });

    test('should log error on failure', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);
      (loader as any).performLoad = () => Promise.reject(new Error('Load error'));

      try {
        await loader.load();
      } catch {}

      expect(console.error).toHaveBeenCalledWith('[Alitycs] Failed to load SDK:', expect.any(Error));
    });
  });

  describe('Concurrent Operations', () => {
    test('should handle concurrent load() calls', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);

      let resolveLoad!: () => void;
      let callCount = 0;
      (loader as any).performLoad = () => {
        callCount++;
        return new Promise<void>(resolve => {
          resolveLoad = resolve;
        });
      };

      const p1 = loader.load();
      const p2 = loader.load();
      const p3 = loader.load();

      resolveLoad();
      await Promise.all([p1, p2, p3]);

      expect(callCount).toBe(1);
      expect(loader.isLoaded()).toBe(true);
    });

    test('should handle multiple track calls before SDK loads', () => {
      const script = document.createElement('script');
      script.setAttribute('data-api-key', 'test_key');
      script.setAttribute('data-auto-track', 'false');
      document.head.appendChild(script);

      delete require.cache[require.resolve('../src/snippet')];
      require('../src/snippet');

      // Queue many calls
      for (let i = 0; i < 100; i++) {
        (window as any).alitycs.track(`event_${i}`, { index: i });
      }

      expect((window as any).alitycs._queue.length).toBe(100);
    });
  });

  describe('Browser Compatibility', () => {
    test('should work without requestIdleCallback', () => {
      const queue = new CallQueue();
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };

      // Remove requestIdleCallback
      delete (window as any).requestIdleCallback;

      const loader = new SDKLoader(config);

      // Should not throw
      expect(() => loader.setup()).not.toThrow();
    });

    test('should work without document.currentScript', () => {
      const script = document.createElement('script');
      script.setAttribute('data-api-key', 'test_key');
      document.head.appendChild(script);

      // Remove currentScript
      Object.defineProperty(document, 'currentScript', {
        value: null,
        configurable: true,
      });

      const { parseScriptConfig } = require('../src/config');

      // Should still find script by attribute
      expect(() => parseScriptConfig()).not.toThrow();
    });
  });

  describe('Queue Overflow', () => {
    test('should handle very large queue', () => {
      const queue = new CallQueue();

      // Add 10,000 calls
      for (let i = 0; i < 10000; i++) {
        queue.push('track', [`event_${i}`]);
      }

      expect(queue.size()).toBe(10000);
    });

    test('should handle queue with mixed call types', () => {
      const queue = new CallQueue();

      queue.push('track', ['event1']);
      queue.push('identify', ['user1']);
      queue.push('page', ['Home']);
      queue.push('group', ['company1']);
      queue.push('alias', ['user2']);
      queue.push('ready', []);

      expect(queue.size()).toBe(6);

      const calls = queue.getAll();
      expect(calls.map(c => c.method)).toEqual(['track', 'identify', 'page', 'group', 'alias', 'ready']);
    });
  });

  describe('Multiple Snippets on Same Page', () => {
    test('should only initialize once', () => {
      const script1 = document.createElement('script');
      script1.setAttribute('data-api-key', 'key1');
      document.head.appendChild(script1);

      const script2 = document.createElement('script');
      script2.setAttribute('data-api-key', 'key2');
      document.head.appendChild(script2);

      delete require.cache[require.resolve('../src/snippet')];
      require('../src/snippet');

      // Should use first key found
      expect((window as any).alitycs._config.apiKey).toBe('key1');
    });
  });

  describe('Invalid Script Injection Points', () => {
    test('should append to head if no script tags exist', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);

      // Ensure no script tags exist
      const existing = document.getElementsByTagName('script');
      while (existing.length > 0) {
        existing[0].parentNode!.removeChild(existing[0]);
      }

      const mockScript = mockScriptCreation();
      const promise = (loader as any).performLoad();

      // Verify the mock script was appended to head
      expect(document.head.contains(mockScript)).toBe(true);
      expect(mockScript.src).toBe('https://cdn.example.com/sdk.js');

      mockScript.onload();
      await promise;
    });

    test('should insert before first script when scripts exist', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);

      // Add an existing script (no src to avoid happy-dom auto-load)
      const existingScript = document.createElement('script');
      existingScript.setAttribute('data-test', 'existing');
      document.head.appendChild(existingScript);

      const mockScript = mockScriptCreation();
      const promise = (loader as any).performLoad();

      // SDK mock should be inserted before the existing script
      const children = Array.from(document.head.childNodes);
      const mockIndex = children.indexOf(mockScript as any);
      const existingIndex = children.indexOf(existingScript as any);
      expect(mockIndex).toBeGreaterThanOrEqual(0);
      expect(mockIndex).toBeLessThan(existingIndex);

      mockScript.onload();
      await promise;
    });
  });

  describe('Malformed Configuration', () => {
    test('should handle invalid SDK URL gracefully', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'not-a-valid-url',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);
      const mockScript = mockScriptCreation();

      const promise = (loader as any).performLoad();
      mockScript.onerror();

      await expect(promise).rejects.toThrow('Failed to load SDK from:');
    });

    test('should handle special characters in API key', () => {
      const script = document.createElement('script');
      script.setAttribute('data-api-key', 'key_with_!@#$%^&*()');
      document.head.appendChild(script);

      const { parseScriptConfig } = require('../src/config');
      const config = parseScriptConfig();

      expect(config.apiKey).toBe('key_with_!@#$%^&*()');
    });
  });

  describe('Error Recovery', () => {
    test('should reset state after failure', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);
      (loader as any).performLoad = () => Promise.reject(new Error('Failed'));

      try {
        await loader.load();
      } catch {}

      expect((loader as any).loading).toBe(false);
      expect((loader as any).loadPromise).toBeNull();
      expect(loader.isLoaded()).toBe(false);
    });

    test('should succeed on retry after failure', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);

      let callCount = 0;
      (loader as any).performLoad = () => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('Temporary failure'));
        return Promise.resolve();
      };

      try {
        await loader.load();
      } catch {}

      await loader.load();
      expect(loader.isLoaded()).toBe(true);
    });

    test('should clean up listeners on successful load after setup', async () => {
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: false,
      };
      const loader = new SDKLoader(config);
      loader.setup(false);

      expect((loader as any).listeners.length).toBe(4);

      (loader as any).performLoad = () => Promise.resolve();
      await loader.load();

      expect((loader as any).listeners.length).toBe(0);
    });
  });

  describe('Debug Mode Edge Cases', () => {
    test('should handle debug mode with missing console methods', () => {
      const originalLog = console.log;
      delete (console as any).log;

      const queue = new CallQueue();
      const config: SnippetConfig = {
        apiKey: 'test_key',
        sdkUrl: 'https://cdn.example.com/sdk.js',
        autoTrack: false,
        debug: true, // Debug enabled but console.log missing
      };

      const loader = new SDKLoader(config);

      // Should not throw even with debug=true
      expect(() => loader.setup()).not.toThrow();

      console.log = originalLog;
    });
  });
});
