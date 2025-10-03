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

export type EventType = 'track' | 'identify' | 'page';

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
}

export interface AnalyticsEvent {
  eventId: string;
  event: string;
  eventType: EventType;
  userId?: string;
  anonymousId: string;
  sessionId: string;
  timestamp: number;
  properties: Record<string, string>;
  context: EventContext;
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
