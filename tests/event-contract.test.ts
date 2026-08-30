import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type TimestampFixtures = {
  valid: Array<{ name: string; timestamp: number }>;
  invalid: Array<{ name: string; timestamp: number }>;
};

const schema = JSON.parse(
  readFileSync(new URL('../specs/event-schema.json', import.meta.url), 'utf8')
) as {
  definitions: {
    AnalyticsEvent: {
      allOf: Array<{
        if: { properties: { event: { enum: string[] } } };
        then: { properties: { eventType: { const: string } } };
      }>;
      properties: { timestamp: { minimum: number } };
    };
  };
};
const fixtures = JSON.parse(
  readFileSync(new URL('../specs/timestamp-conformance.json', import.meta.url), 'utf8')
) as TimestampFixtures;
const minimum = schema.definitions.AnalyticsEvent.properties.timestamp.minimum;

describe('canonical timestamp contract', () => {
  test('accepts Date.now-scale epoch milliseconds', () => {
    expect(Date.now()).toBeGreaterThanOrEqual(minimum);
    for (const fixture of fixtures.valid) expect(fixture.timestamp).toBeGreaterThanOrEqual(minimum);
  });

  test('rejects epoch seconds before SDK or worker ingestion', () => {
    for (const fixture of fixtures.invalid) expect(fixture.timestamp).toBeLessThan(minimum);
  });
});

describe('reserved event-name contract', () => {
  test('only permits profile operations as identify events', () => {
    const reservedRule = schema.definitions.AnalyticsEvent.allOf.find(rule =>
      rule.if.properties.event.enum.includes('$alias')
    );
    expect(reservedRule?.if.properties.event.enum).toEqual(['$alias', '$set', '$set_once', '$unset']);
    expect(reservedRule?.then.properties.eventType.const).toBe('identify');
  });
});
