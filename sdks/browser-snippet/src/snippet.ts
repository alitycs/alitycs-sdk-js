/**
 * @alitycs/browser-snippet
 * Ultra-lightweight analytics snippet (~1KB) that loads the full SDK asynchronously
 *
 * Usage (self-host snippet.min.js and browser.min.js side by side):
 * <script src="/assets/alitycs/snippet.min.js"
 *         data-api-key="YOUR_KEY"
 *         async></script>
 */

import { parseScriptConfig } from './config';
import { CallQueue, replayBufferedCalls } from './queue';
import { createStub } from './stub';
import { SDKLoader } from './loader';

/**
 * Main initialization function
 * This runs immediately when the script loads
 */
export function initializeSnippet(): void {
  // Skip if already initialized
  if (window.alitycs && window.alitycs.loaded) {
    return;
  }

  // Parse configuration from script tag
  const config = parseScriptConfig();

  if (config.debug) {
    console.warn('[Alitycs] Initializing snippet with config:', config);
  }

  // Create call queue
  const queue = new CallQueue();

  // Preserve calls buffered by an inline bootstrap, then attach the real stub.
  const hadPreBufferedCalls = replayBufferedCalls(queue, (window.alitycs as any)?._queue);
  window.alitycs = createStub(queue, config);

  // Auto-track page view if enabled
  if (config.autoTrack) {
    const location = window.location;
    window.alitycs('page', undefined, {
      url: location.href,
      hostname: location.hostname,
      path: location.pathname,
      title: document.title || undefined,
      referrer: document.referrer || '',
    });
  }

  // Setup SDK loader after auto-track so the automatic first pageview loads immediately.
  const loader = new SDKLoader(config);
  loader.setup(hadPreBufferedCalls || queue.size() > 0);

  if (config.debug) {
    console.warn('[Alitycs] Snippet initialized');
  }
}

initializeSnippet();

// Export for testing purposes
export { parseScriptConfig } from './config';
export { CallQueue } from './queue';
export { replayBufferedCalls } from './queue';
export { createStub } from './stub';
export { SDKLoader } from './loader';
