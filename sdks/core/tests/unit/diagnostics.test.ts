import { describe, expect, test } from 'bun:test';
import { DiagnosticsHub } from '../../src/diagnostics';
import { createLogger, type Logger } from '../../src/logger';

describe('DiagnosticsHub', () => {
  test('emits structured events to configured and dynamically registered sinks', () => {
    const configured: string[] = [];
    const registered: string[] = [];
    const hub = new DiagnosticsHub(event => configured.push(event.code), createLogger(false));
    const remove = hub.subscribe(event => registered.push(event.code));

    const event = hub.emit('queue_overflow', { affectedEvents: 2, message: 'full' });

    expect(event).toMatchObject({
      code: 'queue_overflow',
      affectedEvents: 2,
      message: 'full',
      level: 'warn',
    });
    expect(event.at).toBe(event.timestamp);
    expect(configured).toEqual(['queue_overflow']);
    expect(registered).toEqual(['queue_overflow']);

    remove();
    hub.emit({ code: 'flush_completed', level: 'info' });
    expect(configured).toEqual(['queue_overflow', 'flush_completed']);
    expect(registered).toEqual(['queue_overflow']);
  });

  test('does not let a throwing sink interrupt other sinks or delivery code', () => {
    const received: string[] = [];
    const quietLogger: Logger = { warn() {}, error() {} };
    const hub = new DiagnosticsHub(undefined, quietLogger);
    hub.subscribe(() => {
      throw new Error('sink failed');
    });
    hub.subscribe(event => received.push(event.code));

    expect(() => hub.emit('delivery_failed')).not.toThrow();
    expect(received).toEqual(['delivery_failed']);
  });

  test('reference-counts identical registrations so cleanup is isolated', () => {
    const received: string[] = [];
    const sink = (event: { code: string }) => received.push(event.code);
    const hub = new DiagnosticsHub(sink, createLogger(false));
    const remove = hub.subscribe(sink);

    hub.emit('deduplicated');
    remove();
    hub.emit('invalid_event');

    expect(received).toEqual(['deduplicated', 'invalid_event']);
  });

  test('report() accepts a complete diagnostic payload', () => {
    const hub = new DiagnosticsHub(undefined, { warn() {}, error() {} });
    const event = hub.report({ code: 'flush_completed', at: 123, level: 'info', affectedEvents: 4 });

    expect(event).toMatchObject({ code: 'flush_completed', at: 123, timestamp: 123, level: 'info', affectedEvents: 4 });
  });
});
