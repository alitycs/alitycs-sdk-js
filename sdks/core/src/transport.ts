import type { BatchPayload } from './types';
import type { Logger } from './logger';

export interface TransportConfig {
  endpoint: string;
  apiKey: string;
  maxRetries: number;
  logger: Logger;
  /** Per-attempt abort timeout in milliseconds. Defaults to 10_000. */
  requestTimeout?: number;
  /** Injectable inter-retry delay (milliseconds). Defaults to `setTimeout`; tests stub it. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TransportSendOptions {
  keepalive?: boolean;
  maxRetries?: number;
}

export interface TransportResult {
  /** True when the server accepted the batch (2xx). */
  ok: boolean;
  /** HTTP status of the final attempt; undefined when no response was received. */
  status?: number;
  /** True when a later attempt may succeed (network error, timeout, 429, 5xx retries exhausted). */
  transient: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Upper bound for any single retry delay, including a server-suggested Retry-After. */
const MAX_BACKOFF_MS = 10_000;

export class HttpTransport {
  constructor(private config: TransportConfig) {}

  async send(payload: BatchPayload, options: TransportSendOptions = {}): Promise<TransportResult> {
    const body = JSON.stringify(payload);
    const timeout = this.config.requestTimeout ?? DEFAULT_TIMEOUT_MS;
    let lastError: string | undefined;
    let retryAfterMs: number | null = null;
    const maxRetries = options.maxRetries ?? this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        // A 429's Retry-After (seconds or HTTP-date) replaces the default schedule for
        // the next attempt only; the cap still applies so a hostile header cannot
        // stall delivery indefinitely.
        await (this.config.sleep ?? sleep)(retryAfterMs === null ? backoff : Math.min(retryAfterMs, MAX_BACKOFF_MS));
        retryAfterMs = null;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(this.config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          keepalive: options.keepalive ?? false,
          signal: controller.signal,
        });

        if (response.ok) return { ok: true, status: response.status, transient: false };

        const status = response.status;

        // 4xx (except 429) — permanent rejection, don't retry
        if (status >= 400 && status < 500 && status !== 429) {
          this.config.logger.warn(`Transport: ${status} ${response.statusText} — not retrying`);
          return { ok: false, status, transient: false };
        }

        // 429 or 5xx — retry
        if (status === 429) {
          retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        }
        lastError = `HTTP ${status}: ${response.statusText}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxRetries) {
        this.config.logger.warn(`Transport: attempt ${attempt + 1} failed, retrying...`);
      }
    }

    if (lastError !== undefined) {
      this.config.logger.warn('Transport: all retries exhausted', lastError);
    }
    return { ok: false, transient: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parses a Retry-After header value into milliseconds: a delta-seconds integer or an
 * HTTP-date. Returns null when absent or unparseable; a date in the past yields 0.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}
