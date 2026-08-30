import { describe, test, expect } from 'bun:test';
import { SessionManager } from '../../src/session';

describe('SessionManager', () => {
  test('creates a session with anonymousId and sessionId', () => {
    const sm = new SessionManager(30 * 60 * 1000);
    const session = sm.getSession();

    expect(session.id).toMatch(/^sess_/);
    expect(session.anonymousId).toMatch(/^anon_/);
    expect(session.startTime).toBeGreaterThan(0);
    expect(session.lastActivity).toBeGreaterThan(0);
    expect(session.userId).toBeUndefined();
  });

  test('setUserId persists userId', () => {
    const sm = new SessionManager(30 * 60 * 1000);
    sm.setUserId('user-42');
    expect(sm.getSession().userId).toBe('user-42');
  });

  test('reset() rotates session and anonymous identity', () => {
    const sm = new SessionManager(30 * 60 * 1000);
    sm.setUserId('user-42');
    const initial = sm.getSession();

    const reset = sm.reset();

    expect(reset.id).not.toBe(initial.id);
    expect(reset.anonymousId).not.toBe(initial.anonymousId);
    expect(reset.userId).toBeUndefined();
  });

  test('touch() updates lastActivity', () => {
    const sm = new SessionManager(30 * 60 * 1000);
    const before = sm.getSession().lastActivity;

    // Small delay to ensure time moves forward
    const start = Date.now();
    while (Date.now() === start) {} // busy-wait 1ms

    sm.touch();
    expect(sm.getSession().lastActivity).toBeGreaterThanOrEqual(before);
  });

  test('expired session creates new sessionId but preserves anonymousId', () => {
    // Use a very short timeout so session expires immediately
    const sm = new SessionManager(1); // 1ms timeout
    const initial = sm.getSession();

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait 5ms

    sm.touch(); // should detect expiry and create new session

    const after = sm.getSession();
    expect(after.anonymousId).toBe(initial.anonymousId);
    expect(after.id).not.toBe(initial.id);
  });

  test('expired session clears userId (bug fix)', () => {
    const sm = new SessionManager(1); // 1ms timeout
    sm.setUserId('user-42');
    expect(sm.getSession().userId).toBe('user-42');

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait 5ms

    sm.touch(); // expired — new session, userId should be cleared

    expect(sm.getSession().userId).toBeUndefined();
  });

  test('non-expired session preserves all data on touch()', () => {
    const sm = new SessionManager(30 * 60 * 1000);
    sm.setUserId('user-42');
    const initial = sm.getSession();

    sm.touch();

    const after = sm.getSession();
    expect(after.id).toBe(initial.id);
    expect(after.anonymousId).toBe(initial.anonymousId);
    expect(after.userId).toBe('user-42');
  });

  test('rotation notifies the onRotate callback so clients can drop stale identity', () => {
    const rotations: number[] = [];
    const sm = new SessionManager(1, rotated => rotations.push(rotated.startTime));
    const initial = sm.getSession();

    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait past the 1ms timeout

    sm.touch();

    expect(sm.getSession().id).not.toBe(initial.id);
    expect(rotations).toHaveLength(1);
  });

  test('touch persists rolling activity so reload does not split an active visit', () => {
    const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    const originalNow = Date.now;
    const values = new Map<string, string>();
    let now = 1_700_000_000_000;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    Date.now = () => now;

    try {
      const first = new SessionManager(30 * 60 * 1000);
      const sessionId = first.getSession().id;
      now += 20 * 60 * 1000;
      first.touch();
      now += 20 * 60 * 1000;

      const restored = new SessionManager(30 * 60 * 1000);
      expect(restored.getSession().id).toBe(sessionId);
    } finally {
      Date.now = originalNow;
      (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
    }
  });
});
