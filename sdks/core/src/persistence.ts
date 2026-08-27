import type { AnalyticsEvent, PersistenceOptions } from './types';
import { selectEventStorage, type EventStorage } from './storage';
import { generateId } from './utils';

export interface PersistedQueuedEvent {
  seq: number;
  enqueuedAt: number;
  event: AnalyticsEvent;
}

export interface PersistedBatch {
  batchId: string;
  sentAt: number;
  events: AnalyticsEvent[];
  /** Queue ages parallel to `events`; old logs may omit this and use sentAt. */
  enqueuedAt?: number[];
}

export interface PersistenceLoadResult {
  queued: PersistedQueuedEvent[];
  pending: PersistedBatch[];
  pausedUntil?: number;
  nextSeq: number;
  enabled: boolean;
  contention: boolean;
  /** Events intentionally omitted by the configured restore cap. */
  truncatedEvents: number;
}

type EventRecord = {
  t: 'e';
  seq: number;
  enqueuedAt: number;
  event: AnalyticsEvent;
};

type BatchRecord = {
  t: 'b';
  batchId: string;
  sentAt: number;
  events: AnalyticsEvent[];
  enqueuedAt?: number[];
};

type AckRecord = { t: 'a'; batchId: string };

type MetaRecord = {
  t: 'meta';
  version: 1;
  savedAt: number;
  pausedUntil?: number;
  writerId: string;
  heartbeatAt: number;
};

type LogRecord = EventRecord | BatchRecord | AckRecord | MetaRecord;

export const DEFAULT_PERSISTENCE_OPTIONS: Required<
  Pick<PersistenceOptions, 'keyPrefix' | 'maxPersistedBytes' | 'maxRestoredEvents' | 'maxRestoredAgeMs'>
> = {
  keyPrefix: 'alitycs.q.v1.',
  maxPersistedBytes: 262_144,
  maxRestoredEvents: 500,
  maxRestoredAgeMs: 7 * 24 * 60 * 60 * 1000,
};

const LIVE_WRITER_MS = 5_000;
const VERSION = 1 as const;

/**
 * Synchronous append-log persistence for delivery state. The class owns no queue behavior; it
 * only makes event and batch handoff records durable and reconstructs them after a reload.
 */
export class EventPersistence {
  readonly key: string;
  readonly writerId = `writer_${generateId()}`;
  readonly storage: EventStorage | null;
  private readonly options: Required<
    Pick<PersistenceOptions, 'keyPrefix' | 'maxPersistedBytes' | 'maxRestoredEvents' | 'maxRestoredAgeMs'>
  >;
  private records: LogRecord[] = [];
  private pausedUntil: number | undefined;
  private active = false;
  private lastHeartbeatAt = 0;
  private nextSeq = 1;

  constructor(
    persistence: PersistenceOptions | boolean | undefined,
    endpoint: string,
    apiKey: string,
    private readonly now: () => number = Date.now,
    private readonly onError?: (message: string, error?: unknown) => void
  ) {
    const options = !persistence || persistence === true ? {} : persistence;
    this.options = {
      ...DEFAULT_PERSISTENCE_OPTIONS,
      ...options,
    };
    const selectedStorage = !persistence ? null : selectEventStorage(options.storage);
    if (persistence && options.storage && !selectedStorage) onError?.('Unable to use the configured event storage');
    this.storage = selectedStorage;
    this.key = eventStorageKey(endpoint, apiKey, this.options.keyPrefix);
    this.active = this.storage !== null;
  }

  load(): PersistenceLoadResult {
    if (!this.storage || !this.active) {
      return {
        queued: [],
        pending: [],
        nextSeq: this.nextSeq,
        enabled: false,
        contention: false,
        truncatedEvents: 0,
      };
    }

    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch (error) {
      this.disable('Unable to read persisted delivery state', error);
      return {
        queued: [],
        pending: [],
        nextSeq: this.nextSeq,
        enabled: false,
        contention: false,
        truncatedEvents: 0,
      };
    }
    if (!raw) {
      this.takeWriter();
      return {
        queued: [],
        pending: [],
        nextSeq: this.nextSeq,
        enabled: this.active,
        contention: false,
        truncatedEvents: 0,
      };
    }

    const records = parseLog(raw);
    if (!records) {
      this.onError?.('Ignoring corrupt persisted delivery state');
      this.takeWriter();
      return {
        queued: [],
        pending: [],
        nextSeq: this.nextSeq,
        enabled: this.active,
        contention: false,
        truncatedEvents: 0,
      };
    }
    const latestMeta = [...records].reverse().find((record): record is MetaRecord => record.t === 'meta');
    if (latestMeta && latestMeta.version !== VERSION) {
      this.onError?.('Ignoring persisted delivery state with an unsupported version');
      this.takeWriter();
      return {
        queued: [],
        pending: [],
        nextSeq: this.nextSeq,
        enabled: this.active,
        contention: false,
        truncatedEvents: 0,
      };
    }
    if (latestMeta && latestMeta.writerId !== this.writerId && this.now() - latestMeta.heartbeatAt < LIVE_WRITER_MS) {
      this.active = false;
      return {
        queued: [],
        pending: [],
        nextSeq: this.nextSeq,
        enabled: false,
        contention: true,
        truncatedEvents: 0,
      };
    }

    this.records = records;
    this.pausedUntil = latestMeta?.pausedUntil;
    this.nextSeq =
      Math.max(0, ...records.filter((record): record is EventRecord => record.t === 'e').map(record => record.seq)) + 1;
    this.takeWriter();

    const acknowledgements = new Set(
      records.filter((record): record is AckRecord => record.t === 'a').map(record => record.batchId)
    );
    const pending = records
      .filter((record): record is BatchRecord => record.t === 'b' && !acknowledgements.has(record.batchId))
      .map(record => restoreBatch(record, this.now(), this.options.maxRestoredAgeMs));
    const restoredPending = pending.filter((batch): batch is PersistedBatch => batch !== null);
    const pendingEventIds = new Set(restoredPending.flatMap(batch => batch.events.map(event => event.eventId)));
    const queued = records
      .filter((record): record is EventRecord => record.t === 'e' && !pendingEventIds.has(record.event.eventId))
      .map(record => restoreQueuedEvent(record, this.now(), this.options.maxRestoredAgeMs))
      .filter((event): event is PersistedQueuedEvent => event !== null)
      .sort((left, right) => left.seq - right.seq);

    const cappedPending = capPending(restoredPending, this.options.maxRestoredEvents);
    const pendingTruncated = countEvents(restoredPending) - countEvents(cappedPending);
    const remaining = Math.max(0, this.options.maxRestoredEvents - countEvents(cappedPending));
    const cappedQueued = queued.slice(0, remaining);
    const queuedTruncated = queued.length - cappedQueued.length;
    return {
      queued: cappedQueued,
      pending: cappedPending,
      pausedUntil: this.pausedUntil && this.pausedUntil > this.now() ? this.pausedUntil : undefined,
      nextSeq: this.nextSeq,
      enabled: this.active,
      contention: false,
      truncatedEvents: pendingTruncated + queuedTruncated,
    };
  }

  appendEvent(event: AnalyticsEvent, enqueuedAt: number, seq: number = this.nextSeq++): void {
    if (!this.canWrite()) return;
    this.nextSeq = Math.max(this.nextSeq, seq + 1);
    this.append({ t: 'e', seq, enqueuedAt, event });
  }

  appendBatch(batch: PersistedBatch): void {
    if (!this.canWrite()) return;
    this.records = this.records.filter(record => record.t !== 'b' || record.batchId !== batch.batchId);
    this.records = this.records.filter(
      record => record.t !== 'e' || !batch.events.some(event => event.eventId === record.event.eventId)
    );
    this.append({
      t: 'b',
      batchId: batch.batchId,
      sentAt: batch.sentAt,
      events: batch.events,
      ...(batch.enqueuedAt ? { enqueuedAt: batch.enqueuedAt } : {}),
    });
  }

  ackBatch(batchId: string): void {
    if (!this.canWrite()) return;
    this.records = this.records.filter(record => record.t !== 'b' || record.batchId !== batchId);
    this.records = this.records.filter(record => record.t !== 'a' || record.batchId !== batchId);
    this.records.push({ t: 'a', batchId });
    this.compact();
  }

  removeBatch(batchId: string): void {
    if (!this.canWrite()) return;
    this.records = this.records.filter(record => record.t !== 'b' || record.batchId !== batchId);
    this.compact();
  }

  /** Persists a complete queue snapshot for callers that restore or migrate state explicitly. */
  save(
    queued: PersistedQueuedEvent[],
    pending: PersistedBatch[],
    pausedUntil: number | undefined = this.pausedUntil
  ): void {
    this.pausedUntil = pausedUntil;
    this.compact(queued, pending);
  }

  setPausedUntil(pausedUntil: number | undefined): void {
    this.pausedUntil = pausedUntil;
    if (!this.canWrite()) return;
    this.touch(true);
  }

  /** Rewrites the current in-memory log, removing acknowledged records opportunistically. */
  compact(
    queued: PersistedQueuedEvent[] = this.records.filter((record): record is EventRecord => record.t === 'e'),
    pending: PersistedBatch[] = this.records.filter((record): record is BatchRecord => record.t === 'b')
  ): void {
    if (!this.canWrite()) return;
    this.records = [
      ...queued.map(record => ({ t: 'e' as const, ...record })),
      ...pending.map(batch => ({
        t: 'b' as const,
        batchId: batch.batchId,
        sentAt: batch.sentAt,
        events: batch.events,
        ...(batch.enqueuedAt ? { enqueuedAt: batch.enqueuedAt } : {}),
      })),
    ];
    this.touch(true);
  }

  delete(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.key);
      this.records = [];
      this.pausedUntil = undefined;
    } catch (error) {
      this.onError?.('Unable to delete persisted delivery state', error);
    }
  }

  /** Releases this process's writer lease while retaining queued state for a later instance. */
  release(): void {
    if (!this.canWrite()) return;
    const now = this.now();
    this.records.push({
      t: 'meta',
      version: VERSION,
      savedAt: now,
      ...(this.pausedUntil !== undefined ? { pausedUntil: this.pausedUntil } : {}),
      writerId: this.writerId,
      // A cleanly closed instance leaves an immediately adoptable log. A crashed instance has
      // no opportunity to write this marker and is recovered by the normal 5-second heartbeat.
      heartbeatAt: 0,
    });
    this.write();
    this.active = false;
  }

  get isEnabled(): boolean {
    return this.active && this.storage !== null;
  }

  get currentPausedUntil(): number | undefined {
    return this.pausedUntil;
  }

  private canWrite(): boolean {
    return this.active && this.storage !== null;
  }

  private takeWriter(): void {
    if (!this.canWrite()) return;
    this.touch(true);
  }

  private append(record: LogRecord): void {
    if (!this.canWrite()) return;
    this.records.push(record);
    this.touch(false);
  }

  private touch(force: boolean): void {
    if (!this.canWrite()) return;
    const now = this.now();
    if (!force && now - this.lastHeartbeatAt < 1_000) {
      this.write();
      return;
    }
    this.lastHeartbeatAt = now;
    this.records.push({
      t: 'meta',
      version: VERSION,
      savedAt: now,
      ...(this.pausedUntil !== undefined ? { pausedUntil: this.pausedUntil } : {}),
      writerId: this.writerId,
      heartbeatAt: now,
    });
    this.write();
  }

  private write(): void {
    if (!this.storage) return;
    const raw = this.records.map(record => JSON.stringify(record)).join('\n');
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > this.options.maxPersistedBytes) {
      this.disable(`Persisted delivery state exceeded ${this.options.maxPersistedBytes} bytes`);
      return;
    }
    try {
      this.storage.setItem(this.key, raw);
    } catch (error) {
      this.disable('Unable to write persisted delivery state', error);
    }
  }

  private disable(message: string, error?: unknown): void {
    this.active = false;
    this.onError?.(message, error);
  }
}

export function eventStorageKey(endpoint: string, apiKey: string, keyPrefix = 'alitycs.q.v1.'): string {
  return `${keyPrefix}${fingerprintStorageIdentity(endpoint, apiKey)}`;
}

/** Non-secret FNV-1a identity fingerprint used only as a storage namespace. */
export function fingerprintStorageIdentity(endpoint: string, apiKey: string): string {
  const input = `${endpoint}\u0000${apiKey}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function parseLog(raw: string): LogRecord[] | null {
  try {
    const records: LogRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as Partial<LogRecord>;
      if (value.t === 'meta') {
        if (value.version !== VERSION || typeof value.writerId !== 'string') return null;
        records.push(value as MetaRecord);
      } else if (value.t === 'e') {
        if (!Number.isInteger(value.seq) || typeof value.enqueuedAt !== 'number' || !value.event) return null;
        records.push(value as EventRecord);
      } else if (value.t === 'b') {
        if (typeof value.batchId !== 'string' || typeof value.sentAt !== 'number' || !Array.isArray(value.events)) {
          return null;
        }
        records.push(value as BatchRecord);
      } else if (value.t === 'a' && typeof value.batchId === 'string') {
        records.push(value as AckRecord);
      } else {
        return null;
      }
    }
    return records;
  } catch {
    return null;
  }
}

function restoreQueuedEvent(record: EventRecord, now: number, maxAgeMs: number): PersistedQueuedEvent | null {
  if (!Number.isFinite(record.enqueuedAt) || now - record.enqueuedAt > maxAgeMs) return null;
  return { seq: record.seq, enqueuedAt: record.enqueuedAt, event: record.event };
}

function restoreBatch(record: BatchRecord, now: number, maxAgeMs: number): PersistedBatch | null {
  const ages = record.enqueuedAt ?? record.events.map(() => record.sentAt);
  const kept: AnalyticsEvent[] = [];
  const keptAges: number[] = [];
  for (const [index, event] of record.events.entries()) {
    const enqueuedAt = ages[index] ?? record.sentAt;
    if (Number.isFinite(enqueuedAt) && now - enqueuedAt <= maxAgeMs) {
      kept.push(event);
      keptAges.push(enqueuedAt);
    }
  }
  if (kept.length === 0) return null;
  return { batchId: record.batchId, sentAt: record.sentAt, events: kept, enqueuedAt: keptAges };
}

function capPending(batches: PersistedBatch[], maxEvents: number): PersistedBatch[] {
  let remaining = maxEvents;
  const result: PersistedBatch[] = [];
  for (const batch of batches.sort((left, right) => left.sentAt - right.sentAt)) {
    if (remaining <= 0) break;
    if (batch.events.length <= remaining) {
      result.push(batch);
      remaining -= batch.events.length;
      continue;
    }
    result.push({
      ...batch,
      events: batch.events.slice(0, remaining),
      enqueuedAt: batch.enqueuedAt?.slice(0, remaining),
    });
    remaining = 0;
  }
  return result;
}

function countEvents(batches: PersistedBatch[]): number {
  return batches.reduce((total, batch) => total + batch.events.length, 0);
}
