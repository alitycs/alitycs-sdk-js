/**
 * Configuration parser from script tag data attributes
 */

import type { SnippetConfig } from './types';

/**
 * Default CDN URL for the full SDK
 */
const DEFAULT_SDK_URL = 'https://cdn.alitycs.com/sdk@2/browser.min.js';

/**
 * Parse configuration from the current script tag
 */
export function parseScriptConfig(): SnippetConfig {
  // Find the snippet script tag
  const scripts = document.getElementsByTagName('script');
  let snippetScript: HTMLScriptElement | null = null;

  // Look for script with data-api-key or containing 'alitycs'
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    if (script.hasAttribute('data-api-key') || (script.src && script.src.includes('alitycs'))) {
      snippetScript = script;
      break;
    }
  }

  // Fallback to document.currentScript
  if (!snippetScript && document.currentScript) {
    snippetScript = document.currentScript as HTMLScriptElement;
  }

  if (!snippetScript) {
    console.error('[Alitycs] Could not find snippet script tag');
    return {
      apiKey: '',
      sdkUrl: DEFAULT_SDK_URL,
      autoTrack: true,
      debug: false,
    };
  }

  // Parse data attributes
  const apiKey = snippetScript.getAttribute('data-api-key') || '';
  const sdkUrl = snippetScript.getAttribute('data-sdk-url') || DEFAULT_SDK_URL;
  const endpoint = snippetScript.getAttribute('data-endpoint') || undefined;
  const autoTrack = snippetScript.getAttribute('data-auto-track') !== 'false';
  const autoCapture = snippetScript.getAttribute('data-auto-capture') === 'true';
  const debug = snippetScript.hasAttribute('data-debug');

  // Validate API key
  if (!apiKey) {
    console.error('[Alitycs] Missing data-api-key attribute');
  }

  return {
    apiKey,
    sdkUrl,
    autoTrack,
    autoCapture,
    debug,
    endpoint,
  };
}
