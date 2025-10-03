/**
 * Async SDK loader with multiple loading strategies
 */

import type { SnippetConfig } from './types';

export class SDKLoader {
  private loaded = false;
  private loading = false;
  private loadPromise: Promise<void> | null = null;
  private interactionEvents = ['mousedown', 'touchstart', 'keydown', 'scroll'];
  private listeners: Array<() => void> = [];

  constructor(private config: SnippetConfig) {}

  /**
   * Setup lazy loading strategies
   */
  setup(hasQueuedCalls = false): void {
    // If there are pre-buffered calls, load immediately
    if (hasQueuedCalls) {
      this.load();
      return;
    }

    // Strategy 1: Load on user interaction
    this.setupInteractionLoading();

    // Strategy 2: Load on idle (fallback)
    this.setupIdleLoading();

    // Strategy 3: Max delay timeout (5 seconds)
    this.setupTimeoutLoading();
  }

  /**
   * Load on first user interaction
   */
  private setupInteractionLoading(): void {
    const loadOnce = () => {
      if (!this.loaded && !this.loading) {
        this.load();
        this.removeListeners();
      }
    };

    this.interactionEvents.forEach(event => {
      const handler = loadOnce;
      document.addEventListener(event, handler, { passive: true, once: true });
      this.listeners.push(() => document.removeEventListener(event, handler));
    });
  }

  /**
   * Load when browser is idle
   */
  private setupIdleLoading(): void {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(
        () => {
          if (!this.loaded && !this.loading) {
            this.load();
          }
        },
        { timeout: 5000 }
      );
    } else {
      // Fallback for browsers without requestIdleCallback
      setTimeout(() => {
        if (!this.loaded && !this.loading) {
          this.load();
        }
      }, 3000);
    }
  }

  /**
   * Maximum delay timeout
   */
  private setupTimeoutLoading(): void {
    setTimeout(() => {
      if (!this.loaded && !this.loading) {
        this.load();
      }
    }, 5000);
  }

  /**
   * Load the full SDK
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loading = true;
    this.loadPromise = this.performLoad();

    try {
      await this.loadPromise;
      this.loaded = true;
      this.loading = false;
      this.removeListeners();

      if (this.config.debug) {
        console.warn('[Alitycs] SDK loaded successfully');
      }
    } catch (error) {
      this.loading = false;
      this.loadPromise = null;
      console.error('[Alitycs] Failed to load SDK:', error);
      throw error;
    }
  }

  /**
   * Perform the actual script loading
   */
  private performLoad(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if SDK is already loaded
      if ((window as any).AlitycsSDK) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = this.config.sdkUrl || 'https://cdn.alitycs.com/sdk@2/browser.min.js';
      script.async = true;
      script.defer = true;

      // Pass config via data attributes
      if (this.config.apiKey) {
        script.setAttribute('data-api-key', this.config.apiKey);
      }
      if (this.config.endpoint) {
        script.setAttribute('data-endpoint', this.config.endpoint);
      }
      if (this.config.autoCapture) {
        script.setAttribute('data-auto-capture', 'true');
      }
      if (this.config.debug) {
        script.setAttribute('data-debug', 'true');
      }

      script.onload = () => {
        if (this.config.debug) {
          console.warn('[Alitycs] Script loaded from:', script.src);
        }
        resolve();
      };

      script.onerror = () => {
        reject(new Error(`Failed to load SDK from: ${script.src}`));
      };

      // Insert script
      const firstScript = document.getElementsByTagName('script')[0];
      if (firstScript?.parentNode) {
        firstScript.parentNode.insertBefore(script, firstScript);
      } else {
        document.head.appendChild(script);
      }
    });
  }

  /**
   * Remove all event listeners
   */
  private removeListeners(): void {
    this.listeners.forEach(remove => remove());
    this.listeners = [];
  }

  /**
   * Check if SDK is loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}
