import type { BatchPayload } from './types';
import type { Logger } from './logger';

export interface TransportConfig {
  endpoint: string;
  apiKey: string;
  maxRetries: number;
  logger: Logger;
}

export interface TransportSendOptions {
  keepalive?: boolean;
  maxRetries?: number;
}

export class HttpTransport {
  constructor(private config: TransportConfig) {}

  async send(payload: BatchPayload, options: TransportSendOptions = {}): Promise<void> {
    const body = JSON.stringify(payload);
    let lastError: Error | undefined;
    const maxRetries = options.maxRetries ?? this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        await sleep(delay);
      }

      try {
        const response = await fetch(this.config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          keepalive: options.keepalive ?? false,
        });

        if (response.ok) return;

        const status = response.status;

        // 4xx (except 429) — don't retry
        if (status >= 400 && status < 500 && status !== 429) {
          this.config.logger.warn(`Transport: ${status} ${response.statusText} — not retrying`);
          return;
        }

        // 429 or 5xx — retry
        lastError = new Error(`HTTP ${status}: ${response.statusText}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < maxRetries) {
        this.config.logger.warn(`Transport: attempt ${attempt + 1} failed, retrying...`);
      }
    }

    if (lastError) {
      this.config.logger.warn('Transport: all retries exhausted — dropping batch', lastError.message);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
