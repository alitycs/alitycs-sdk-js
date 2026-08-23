export interface AlitycsConfig {
  apiKey: string;
  endpoint?: string;
  flushInterval?: number;
  flushSize?: number;
  maxQueueSize?: number;
  maxRetries?: number;
  debug?: boolean;
  sessionTimeout?: number;
  batching?: boolean;
}

export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  flushInterval: number;
  flushSize: number;
  maxQueueSize: number;
  maxRetries: number;
  debug: boolean;
  sessionTimeout: number;
  batching: boolean;
}

export type EventType = 'track' | 'identify' | 'page' | 'error';

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
