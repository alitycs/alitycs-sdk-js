import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PERSISTENCE_OPTIONS,
  EventPersistence,
  eventStorageKey,
  fingerprintStorageIdentity,
} from '../../src/persistence';
import { MemoryEventStorage, type EventStorage } from '../../src/storage';
import type { AnalyticsEvent } from '../../src/types';

const ENDPOINT = 'https://api.test.com/events';
const API_KEY = 'key-a';

function makeEvent(id: string, name = id): AnalyticsEvent {
  return {
    eventId: id,
    event: name,
    eventType: 'track',
    anonymousId: 'anon_1',
    sessionId: 'sess_1',
    timestamp: 1_700_000_000_000,
    properties: {},
    context: { sdkVersion: '1.0.1', sdkLanguage: 'typescript' },
  };
}

function staleReload(storage: EventStorage, now: number, options: Record<string, unknown> = {}) {
  return new EventPersistence({ storage, ...(options as object) }, ENDPOINT, API_KEY, () => now);
}

describe('EventPersistence', () => {
  test('uses a non-secret, client-specific fingerprinted key', () => {
    expect(fingerprintStorageIdentity(ENDPOINT, API_KEY)).toMatch(/^[0-9a-f]{8}$/);
    expect(eventStorageKey(ENDPOINT, API_KEY)).toBe(
      `${DEFAULT_PERSISTENCE_OPTIONS.keyPrefix}${fingerprintStorageIdentity(ENDPOINT, API_KEY)}`
    );
    expect(eventStorageKey(ENDPOINT, 'different-key')).not.toBe(eventStorageKey(ENDPOINT, API_KEY));
    expect(eventStorageKey('https://other.test/events', API_KEY)).not.toBe(eventStorageKey(ENDPOINT, API_KEY));
  });

  test('round-trips queued events and restores their sequence and age', () => {
    const storage = new MemoryEventStorage();
    const first = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_000);
    first.load();
    first.appendEvent(makeEvent('one'), 9_000, 4);
    first.appendEvent(makeEvent('two'), 9_500, 5);

    const restored = staleReload(storage, 16_000);
    const loaded = restored.load();

    expect(loaded.contention).toBe(false);
    expect(loaded.queued.map(item => [item.seq, item.enqueuedAt, item.event.eventId])).toEqual([
      [4, 9_000, 'one'],
      [5, 9_500, 'two'],
    ]);
    expect(loaded.pending).toHaveLength(0);
    expect(loaded.nextSeq).toBe(6);
  });

  test('a batch handoff replaces event records and restores pending before queued records', () => {
    const storage = new MemoryEventStorage();
    const first = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_000);
    first.load();
    const firstEvent = makeEvent('first');
    const secondEvent = makeEvent('second');
    first.appendEvent(firstEvent, 9_000, 1);
    first.appendEvent(secondEvent, 9_100, 2);
    first.appendBatch({
      batchId: 'batch_crash',
      sentAt: 9_900,
      events: [firstEvent],
      enqueuedAt: [9_000],
    });

    const loaded = staleReload(storage, 16_000).load();
    expect(loaded.pending).toMatchObject([{ batchId: 'batch_crash', events: [firstEvent] }]);
    expect(loaded.queued.map(item => item.event.eventId)).toEqual(['second']);
  });

  test('acknowledging a batch removes it from the next restore', () => {
    const storage = new MemoryEventStorage();
    const first = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_000);
    first.load();
    first.appendBatch({ batchId: 'batch_ack', sentAt: 9_000, events: [makeEvent('ack')] });
    first.ackBatch('batch_ack');

    expect(staleReload(storage, 16_000).load().pending).toHaveLength(0);
  });

  test('restores pausedUntil and drops expired or over-cap entries', () => {
    const storage = new MemoryEventStorage();
    const first = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_000);
    first.load();
    first.setPausedUntil(20_000);
    for (let index = 0; index < 4; index++) {
      first.appendEvent(makeEvent(`event-${index}`), 9_000 + index, index + 1);
    }

    const loaded = staleReload(storage, 16_000, {
      maxRestoredEvents: 2,
      maxRestoredAgeMs: 8_000,
    }).load();
    expect(loaded.pausedUntil).toBe(20_000);
    expect(loaded.queued.map(item => item.event.eventId)).toEqual(['event-0', 'event-1']);
    expect(loaded.truncatedEvents).toBe(2);

    const expired = staleReload(storage, 20_000, { maxRestoredAgeMs: 5_000 }).load();
    expect(expired.queued).toHaveLength(0);
    expect(expired.pausedUntil).toBeUndefined();
  });

  test('live foreign writers enter memory-only contention mode and stale writers can be adopted', () => {
    const storage = new MemoryEventStorage();
    const owner = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_000);
    owner.load();
    owner.appendEvent(makeEvent('owned'), 10_000, 1);

    const contender = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_001);
    const contention = contender.load();
    expect(contention.contention).toBe(true);
    expect(contention.enabled).toBe(false);
    contender.appendEvent(makeEvent('not-written'), 10_001, 2);
    expect(storage.getItem(eventStorageKey(ENDPOINT, API_KEY))).not.toContain('not-written');

    const adopted = staleReload(storage, 16_000);
    expect(adopted.load().queued.map(item => item.event.eventId)).toEqual(['owned']);
    expect(adopted.isEnabled).toBe(true);
  });

  test('corrupt and unsupported logs are ignored safely', () => {
    const storage = new MemoryEventStorage();
    const key = eventStorageKey(ENDPOINT, API_KEY);
    storage.setItem(key, '{not-json');
    expect(new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 1_000).load().queued).toHaveLength(0);

    storage.setItem(key, JSON.stringify({ t: 'meta', version: 99, writerId: 'old', heartbeatAt: 0 }));
    expect(new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 10_000).load().pending).toHaveLength(0);
  });

  test('save() writes an explicit snapshot and delete() removes it', () => {
    const storage = new MemoryEventStorage();
    const persistence = new EventPersistence({ storage }, ENDPOINT, API_KEY, () => 1_000);
    persistence.load();
    persistence.save(
      [{ seq: 1, enqueuedAt: 900, event: makeEvent('saved') }],
      [{ batchId: 'pending', sentAt: 950, events: [makeEvent('batch')] }],
      2_000
    );

    expect(storage.getItem(persistence.key)).toContain('saved');
    expect(storage.getItem(persistence.key)).toContain('pending');
    persistence.delete();
    expect(storage.getItem(persistence.key)).toBeNull();
  });
});
