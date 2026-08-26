/**
 * Configuration parser from script tag data attributes
 */

import type { SnippetConfig } from './types';
import { DEFAULT_SDK_URL } from './build-constants';

export { DEFAULT_SDK_URL };

function findSnippetScript(): HTMLScriptElement | null {
  // Prefer the script that is currently executing us; fall back to scanning the page.
  const current = document.currentScript as HTMLScriptElement | null;
  if (current) return current;

  const scripts = document.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    if (script.hasAttribute('data-api-key') || (script.src && script.src.includes('alitycs'))) {
      return script;
    }
  }
  return null;
}

/**
 * Parse configuration from the current script tag
 */
export function parseScriptConfig(): SnippetConfig {
  const snippetScript = findSnippetScript();

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
