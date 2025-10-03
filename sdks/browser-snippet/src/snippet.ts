/**
 * @alitycs/browser-snippet
 * Ultra-lightweight analytics snippet (~1KB) that loads the full SDK asynchronously
 *
 * Usage:
 * <script src="https://cdn.alitycs.com/snippet.min.js"
 *         data-api-key="YOUR_KEY"
 *         async></script>
 */

import { parseScriptConfig } from './config';
import { CallQueue } from './queue';
import { createStub } from './stub';
import { SDKLoader } from './loader';

/**
 * Main initialization function
 * This runs immediately when the script loads
 */
(function initializeSnippet() {
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

  // Create stub object and attach to window
  let hadPreBufferedCalls = false;
  if (!window.alitycs) {
    window.alitycs = createStub(queue, config);
  } else {
    // If alitycs already exists (user defined it), preserve any existing calls
    const existingCalls = (window.alitycs as any)._queue || [];
    hadPreBufferedCalls = existingCalls.length > 0;
    existingCalls.forEach((call: any) => {
      if (Array.isArray(call)) {
        // Format: ['method', ...args]
        queue.push(call[0], call.slice(1));
      } else if (call.method) {
        // Format: { method, args }
        queue.push(call.method, call.args);
      }
    });
    window.alitycs = createStub(queue, config);
  }

  // Setup SDK loader — load immediately if pre-buffered calls exist
  const loader = new SDKLoader(config);
  loader.setup(hadPreBufferedCalls);

  // Auto-track page view if enabled
  if (config.autoTrack) {
    window.alitycs('page');
  }

  if (config.debug) {
    console.warn('[Alitycs] Snippet initialized');
  }
})();

// Export for testing purposes
export { parseScriptConfig } from './config';
export { CallQueue } from './queue';
export { createStub } from './stub';
export { SDKLoader } from './loader';
