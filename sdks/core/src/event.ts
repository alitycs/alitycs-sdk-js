import type {
  AnalyticsEvent,
  EventContext,
  EventType,
  RevenuePayload,
} from './types';
import { collectContext } from './context';
import { generateId, serializeProperties } from './utils';

/**
 * Reserved event names carried on eventType 'identify'. They signal profile operations
 * rather than product activity: '$alias' links identities, '$set'/'$set_once'/'$unset'
 * mutate person traits. Regular tracking must not use these names.
 */
export const RESERVED_EVENT_NAMES = {
  alias: '$alias',
  set: '$set',
  setOnce: '$set_once',
  unset: '$unset',
} as const;

// Client-side event limits enforced before queueing so invalid events never leave the host.
const MAX_PROPERTIES = 50;
const MAX_KEY_LENGTH = 100;
const MAX_VALUE_LENGTH = 1000;
const MAX_EVENT_BYTES = 64 * 1024;
/** Epoch-millisecond floor: values below this are seconds-sent or garbage timestamps. */
const MIN_EPOCH_MS = 1e12;

/** Returns the reason the event is invalid, or null when it passes all client-side limits. */
export function validateEvent(event: AnalyticsEvent): string | null {
  if (!event.event.trim()) return 'blank event name';
  if (!event.userId && !event.anonymousId) return 'no user identity';
  if (!(event.timestamp >= MIN_EPOCH_MS)) return 'timestamp not in epoch milliseconds';
  const entries = Object.entries(event.properties);
  if (entries.length > MAX_PROPERTIES) return `>${MAX_PROPERTIES} properties`;
  let size = (event.userId?.length ?? 0) + event.anonymousId.length + event.event.length + 200;
  for (const [key, value] of entries) {
    if (key.length > MAX_KEY_LENGTH) return `key >${MAX_KEY_LENGTH} chars`;
    if (value.length > MAX_VALUE_LENGTH) return `value >${MAX_VALUE_LENGTH} chars`;
    size += key.length + value.length;
  }
  if (size > MAX_EVENT_BYTES) return `estimated size ${size}B >64KB`;
  return null;
}

export interface BuildAnalyticsEventInput {
  eventType: EventType;
  eventName: string;
  userId?: string;
  anonymousId: string;
  /** Absent on server-side events, where no ambient browser session exists. */
  sessionId?: string;
  properties?: Record<string, unknown>;
  contextOverrides?: Partial<EventContext>;
  /** Epoch milliseconds; defaults to now. Callers own any monotonic clamping. */
  timestamp?: number;
  revenue?: RevenuePayload;
  dedupeKey?: string;
}

/**
 * Builds one wire-ready AnalyticsEvent from explicit inputs only — no ambient identity,
 * session, or clock state. Shared by the stateful client's enqueue path and the stateless
 * server client, so both produce byte-identical shapes for the same logical call.
 */
export function buildAnalyticsEvent(input: BuildAnalyticsEventInput): AnalyticsEvent {
  return {
    eventId: `evt_${generateId()}`,
    event: input.eventName,
    eventType: input.eventType,
    userId: input.userId,
    anonymousId: input.anonymousId,
    sessionId: input.sessionId ?? '',
    timestamp: input.timestamp ?? Date.now(),
    properties: serializeProperties(input.properties ?? {}),
    revenue: input.revenue,
    context: { ...collectContext(), ...input.contextOverrides },
    dedupeKey: input.dedupeKey,
  };
}
