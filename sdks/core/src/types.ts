import type { DiagnosticsSink } from './diagnostics';
import type { EventStorage } from './storage';

export interface AlitycsConfig {
  apiKey: string;
  endpoint?: string;
  flushInterval?: number;
  flushSize?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  /** Per-request abort timeout in milliseconds. Defaults to 10_000. */
  requestTimeout?: number;
  debug?: boolean;
  sessionTimeout?: number;
  batching?: boolean;
  /** Receives structured delivery and validation diagnostics. */
  onDiagnostics?: DiagnosticsSink;
  /** Persist queued and in-flight batches in a write-ahead log. Disabled by default. */
  persistence?: boolean | PersistenceOptions;
  /** Queue behavior when maxQueueSize has been reached. */
  overflowPolicy?: OverflowPolicy;
}

export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  flushInterval: number;
  flushSize: number;
  maxQueueSize: number;
  maxRetries: number;
  /** Per-request abort timeout in milliseconds. Defaults to 10_000. */
  requestTimeout?: number;
  debug: boolean;
  sessionTimeout: number;
  batching: boolean;
  onDiagnostics?: DiagnosticsSink;
  persistence?: false | PersistenceOptions;
  overflowPolicy?: OverflowPolicy;
}

export type OverflowPolicy = 'drop-newest' | 'drop-oldest';

export interface PersistenceOptions {
  /** Optional storage adapter. Browser localStorage is selected when omitted. */
  storage?: EventStorage;
  /** Prefix before the non-secret endpoint/key fingerprint. */
  keyPrefix?: string;
  /** Maximum serialized WAL size before persistence is disabled for this instance. */
  maxPersistedBytes?: number;
  /** Maximum number of events restored into memory on startup. */
  maxRestoredEvents?: number;
  /** Events older than this age are ignored during restore. */
  maxRestoredAgeMs?: number;
}

export interface DeliveryError {
  at: number;
  kind: string;
  status?: number;
  message: string;
  affectedEvents: number;
}

export interface DeliveryStats {
  queueDepth: number;
  inFlight: number;
  quarantined: number;
  poisonIsolated: number;
  pausedUntil?: number;
  oldestQueuedAt?: number;
  oldestQueuedAgeMs?: number;
  lastError: DeliveryError | null;
  delivered: number;
  failedDeliveries: number;
  requeued: number;
  retries: number;
  rateLimited: number;
  acceptedQuotaExceeded: number;
  droppedOverflow: number;
  droppedInvalid: number;
  droppedRejected: number;
  droppedDrainGiveUp: number;
  droppedTotal: number;
  deduplicated: number;
  restoredFromStorage: number;
}

export type EventType = 'track' | 'identify' | 'page' | 'error';

/**
 * Reserved event names carried on eventType 'identify' for profile operations
 * ('$alias', '$set', '$set_once', '$unset'). Not valid names for track().
 */
export type ReservedEventName = '$alias' | '$set' | '$set_once' | '$unset';

export interface EventContext {
  locale?: string;
  timezone?: string;
  userAgent?: string;
  url?: string;
  referrer?: string;
  screen?: Record<string, string>;
  sdkVersion: string;
  sdkLanguage: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

export interface EventOptions {
  dedupeKey?: string;
  dedupeWindowMs?: number; // default 500
}

export type RevenuePayload =
  | {
      version: 1;
      kind: 'transaction';
      factId: string;
      amount: string;
      currency: string;
      customerId?: string;
    }
  | {
      version: 1;
      kind: 'mrr_snapshot';
      factId: string;
      subscriptionId: string;
      customerId: string;
      mrrAmount: string;
      currency: string;
    }
  | {
      version: 1;
      kind: 'mrr_baseline_complete';
      factId: string;
      currency: string;
      expectedActiveSubscriptions: number;
    };

export interface AnalyticsEvent {
  eventId: string;
  event: string;
  eventType: EventType;
  userId?: string;
  anonymousId: string;
  sessionId: string;
  timestamp: number;
  properties: Record<string, string>;
  revenue?: RevenuePayload;
  context: EventContext;
  dedupeKey?: string;
}

export interface BatchPayload {
  batchId: string;
  sentAt: number;
  events: AnalyticsEvent[];
}

export interface SessionData {
  id: string;
  anonymousId: string;
  userId?: string;
  startTime: number;
  lastActivity: number;
}
