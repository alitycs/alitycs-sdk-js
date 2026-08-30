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
  /** Full server-directed delay; the batch manager persists the resulting deadline. */
  retryAfterMs?: number;
  /** Machine-readable response body code, when the server supplied one. */
  code?: string;
  /** Best-effort response or network error description. */
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Normal exponential backoff remains bounded. */
const MAX_BACKOFF_MS = 10_000;
/** Longer server pauses are returned to the batch manager instead of blocking this request. */
const MAX_IN_ATTEMPT_RETRY_AFTER_MS = 60_000;
/** Malformed or distant server deadlines must not suspend the entire queue indefinitely. */
const MAX_SERVER_RETRY_AFTER_MS = 5 * 60_000;

export class HttpTransport {
  constructor(private config: TransportConfig) {}

  async send(payload: BatchPayload, options: TransportSendOptions = {}): Promise<TransportResult> {
    const body = JSON.stringify(payload);
    const timeout = this.config.requestTimeout ?? DEFAULT_TIMEOUT_MS;
    let lastError: string | undefined;
    let retryAfterMs: number | null = null;
    let lastStatus: number | undefined;
    let lastCode: string | undefined;
    const maxRetries = options.maxRetries ?? this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        // A short 429 Retry-After replaces the default schedule for the next attempt.
        // Longer deadlines return from send() and are enforced by BatchManager's pause state.
        if (retryAfterMs === null) await (this.config.sleep ?? sleep)(backoff);
        else await (this.config.sleep ?? sleep)(retryAfterMs);
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
        lastStatus = status;
        const errorBody = await readErrorBody(response);
        lastCode = errorBody.code;
        lastError = errorBody.message ?? `HTTP ${status}: ${response.statusText}`;

        // 4xx (except 429) — permanent rejection, don't retry
        if (status >= 400 && status < 500 && status !== 429) {
          this.config.logger.warn(`Transport: ${status} ${response.statusText} — not retrying`);
          return { ok: false, status, transient: false, code: lastCode, message: lastError };
        }

        // The worker publishes monthly-quota 429s after Kafka acceptance. Those events
        // must never be replayed, even if the HTTP response is itself retryable by status.
        if (status === 429) {
          retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? parseBodyRetryAfter(errorBody);
          if (lastCode === 'monthly_event_quota_exceeded') {
            return {
              ok: false,
              status,
              transient: false,
              retryAfterMs: retryAfterMs ?? undefined,
              code: lastCode,
              message: lastError,
            };
          }
          if (attempt < maxRetries && retryAfterMs !== null && retryAfterMs > MAX_IN_ATTEMPT_RETRY_AFTER_MS) {
            return {
              ok: false,
              status,
              transient: true,
              retryAfterMs,
              ...(lastCode ? { code: lastCode } : {}),
              ...(lastError ? { message: lastError } : {}),
            };
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastStatus = undefined;
        lastCode = undefined;
        retryAfterMs = null;
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
    return {
      ok: false,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      transient: true,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      ...(lastCode ? { code: lastCode } : {}),
      ...(lastError ? { message: lastError } : {}),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readErrorBody(response: Response): Promise<{ code?: string; message?: string; retryAfterMs?: number }> {
  try {
    const parsed = JSON.parse(await response.clone().text()) as Record<string, unknown>;
    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      message: typeof parsed.error === 'string' ? parsed.error : undefined,
      retryAfterMs:
        typeof parsed.retry_after_seconds === 'number' && Number.isFinite(parsed.retry_after_seconds)
          ? clampRetryAfterMs(parsed.retry_after_seconds * 1000)
          : undefined,
    };
  } catch {
    return {};
  }
}

function parseBodyRetryAfter(body: { retryAfterMs?: number }): number | null {
  return body.retryAfterMs ?? null;
}

/**
 * Parses a Retry-After header value into milliseconds: a delta-seconds integer or an
 * HTTP-date. Returns null when absent or unparseable; a date in the past yields 0.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isFinite(milliseconds) ? clampRetryAfterMs(milliseconds) : null;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return clampRetryAfterMs(when - now);
}

function clampRetryAfterMs(milliseconds: number): number {
  return Math.min(MAX_SERVER_RETRY_AFTER_MS, Math.max(0, milliseconds));
}
