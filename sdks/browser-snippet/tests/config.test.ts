/**
 * Tests for config parser (parseScriptConfig)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Window } from 'happy-dom';

const EXPECTED_DEFAULT_SDK_URL = 'https://cdn.jsdelivr.net/npm/@alitycs/browser@1.0.3/dist/browser.min.js';

describe('parseScriptConfig', () => {
  let window: Window;
  let document: Document;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // Create a new DOM environment for each test
    window = new Window({ settings: { disableJavaScriptFileLoading: true } });
    document = window.document as unknown as Document;

    // Mock console.error to capture warnings
    originalConsoleError = console.error;
    console.error = mock(() => {});

    // Set up global document for the module
    (global as any).document = document;
    (global as any).window = window;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    delete (global as any).document;
    delete (global as any).window;
  });

  test('should find script by data-api-key attribute', () => {
    // Create snippet script tag
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key_123');
    script.setAttribute('src', 'https://example.com/snippet.js');
    document.head.appendChild(script);

    // Import and test
    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.apiKey).toBe('test_key_123');
  });

  test('should find script by URL containing "alitycs"', () => {
    const script = document.createElement('script');
    script.src = 'https://cdn.example.com/alitycs/snippet.min.js';
    script.setAttribute('data-api-key', 'key_from_url');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.apiKey).toBe('key_from_url');
  });

  test('should fallback to document.currentScript', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'current_script_key');
    document.head.appendChild(script);

    // Mock document.currentScript
    Object.defineProperty(document, 'currentScript', {
      value: script,
      configurable: true,
    });

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.apiKey).toBe('current_script_key');
  });

  test('should parse data-sdk-url attribute', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-sdk-url', 'https://custom-cdn.com/sdk.js');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.sdkUrl).toBe('https://custom-cdn.com/sdk.js');
  });

  test('should parse data-endpoint attribute', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-endpoint', 'https://api.custom.com/events');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.endpoint).toBe('https://api.custom.com/events');
  });

  test('should parse data-auto-track="false"', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-auto-track', 'false');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.autoTrack).toBe(false);
  });

  test('should default autoTrack to true when not set', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.autoTrack).toBe(true);
  });

  test('should parse data-debug attribute', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    script.setAttribute('data-debug', '');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.debug).toBe(true);
  });

  test('should default debug to false when not set', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.debug).toBe(false);
  });

  test('should fall back to same-origin SDK path when the snippet has no src', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'test_key');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.sdkUrl).toBe(EXPECTED_DEFAULT_SDK_URL);
  });

  test('should prefer document.currentScript over scanned script tags', () => {
    const scanned = document.createElement('script');
    scanned.setAttribute('data-api-key', 'scanned_key');
    scanned.setAttribute('src', 'https://cdn.example.com/scanned/snippet.min.js');
    document.head.appendChild(scanned);

    const executing = document.createElement('script');
    executing.setAttribute('data-api-key', 'current_key');
    executing.setAttribute('src', 'https://cdn.example.com/current/snippet.min.js');
    executing.setAttribute('data-sdk-url', 'https://cdn.example.com/current/browser.min.js');
    document.head.appendChild(executing);
    Object.defineProperty(document, 'currentScript', {
      value: executing,
      configurable: true,
    });

    try {
      const { parseScriptConfig } = require('../src/config');
      const config = parseScriptConfig();

      expect(config.apiKey).toBe('current_key');
      expect(config.sdkUrl).toBe('https://cdn.example.com/current/browser.min.js');
    } finally {
      Object.defineProperty(document, 'currentScript', { value: null, configurable: true });
    }
  });

  test('should return empty apiKey when missing', () => {
    const script = document.createElement('script');
    script.src = 'https://cdn.example.com/alitycs/snippet.min.js';
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.apiKey).toBe('');
    expect(console.error).toHaveBeenCalledWith('[Alitycs] Missing data-api-key attribute');
  });

  test('should log error when no script tag found', () => {
    // No script tags in document

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(console.error).toHaveBeenCalledWith('[Alitycs] Could not find snippet script tag');
    expect(config.apiKey).toBe('');
  });

  test('should return defaults when no script tag found', () => {
    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config).toEqual({
      apiKey: '',
      sdkUrl: EXPECTED_DEFAULT_SDK_URL,
      autoTrack: true,
      debug: false,
    });
  });

  test('should parse all attributes together', () => {
    const script = document.createElement('script');
    script.setAttribute('data-api-key', 'full_test_key');
    script.setAttribute('data-sdk-url', 'https://my-cdn.com/sdk.js');
    script.setAttribute('data-endpoint', 'https://my-api.com/events');
    script.setAttribute('data-auto-track', 'false');
    script.setAttribute('data-debug', '');
    document.head.appendChild(script);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config).toEqual({
      apiKey: 'full_test_key',
      sdkUrl: 'https://my-cdn.com/sdk.js',
      endpoint: 'https://my-api.com/events',
      autoTrack: false,
      autoCapture: false,
      debug: true,
    });
  });

  test('should find first matching script when multiple exist', () => {
    const script1 = document.createElement('script');
    script1.setAttribute('data-api-key', 'first_key');
    document.head.appendChild(script1);

    const script2 = document.createElement('script');
    script2.setAttribute('data-api-key', 'second_key');
    document.head.appendChild(script2);

    const { parseScriptConfig } = require('../src/config');
    const config = parseScriptConfig();

    expect(config.apiKey).toBe('first_key');
  });
});
