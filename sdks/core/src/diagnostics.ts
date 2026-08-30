import type { Logger } from './logger';

/** Stable machine-readable reasons emitted by the delivery pipeline. */
export type DiagnosticCode =
  | 'invalid_event'
  | 'deduplicated'
  | 'queue_overflow'
  | 'delivery_failed'
  | 'delivery_requeued'
  | 'retry_scheduled'
  | 'rate_limited'
  | 'accepted_quota_exceeded'
  | 'event_rejected'
  | 'event_quarantined'
  | 'drain_gave_up'
  | 'storage_error'
  | 'storage_contention'
  | 'restored_from_storage'
  | 'flush_paused'
  | 'flush_completed';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  code: DiagnosticCode;
  /** Epoch milliseconds at which the SDK observed the condition. */
  at: number;
  /** Alias retained in the payload for consumers that use timestamp terminology. */
  timestamp: number;
  level: DiagnosticLevel;
  message?: string;
  kind?: string;
  status?: number;
  batchId?: string;
  affectedEvents?: number;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export type DiagnosticsSink = (event: DiagnosticEvent) => void;

export type DiagnosticInput = Omit<DiagnosticEvent, 'at' | 'timestamp' | 'level'> &
  Partial<Pick<DiagnosticEvent, 'at' | 'timestamp' | 'level'>>;

/**
 * Fans delivery diagnostics out to an application sink and the SDK logger. Sink failures are
 * isolated so an observability callback can never interrupt event delivery.
 */
export class DiagnosticsHub {
  private readonly sinks = new Map<DiagnosticsSink, number>();

  constructor(
    sink?: DiagnosticsSink,
    private readonly logger?: Logger
  ) {
    if (sink) this.subscribe(sink);
  }

  /** Registers a sink and returns an idempotent cleanup function. */
  subscribe(sink: DiagnosticsSink): () => void {
    this.sinks.set(sink, (this.sinks.get(sink) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = this.sinks.get(sink) ?? 0;
      if (count <= 1) this.sinks.delete(sink);
      else this.sinks.set(sink, count - 1);
    };
  }

  emit(code: DiagnosticCode, details?: Partial<DiagnosticEvent>): DiagnosticEvent;
  emit(input: DiagnosticInput): DiagnosticEvent;
  emit(codeOrInput: DiagnosticCode | DiagnosticInput, details: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
    const input: DiagnosticInput = typeof codeOrInput === 'string' ? { code: codeOrInput, ...details } : codeOrInput;
    const at = input.at ?? input.timestamp ?? Date.now();
    const event: DiagnosticEvent = {
      ...input,
      at,
      timestamp: input.timestamp ?? at,
      level: input.level ?? defaultLevel(input.code),
    };

    for (const sink of this.sinks.keys()) {
      try {
        sink(event);
      } catch (error) {
        this.logger?.error('Diagnostics sink failed', error);
      }
    }

    const message = event.message ?? event.code;
    if (event.level === 'error') this.logger?.error(message, event);
    else if (event.level === 'warn') this.logger?.warn(message, event);
    return event;
  }

  report(input: DiagnosticInput): DiagnosticEvent {
    return this.emit(input);
  }
}

function defaultLevel(code: DiagnosticCode): DiagnosticLevel {
  switch (code) {
    case 'storage_error':
    case 'storage_contention':
    case 'delivery_failed':
    case 'drain_gave_up':
      return 'error';
    case 'flush_completed':
      return 'info';
    default:
      return 'warn';
  }
}
