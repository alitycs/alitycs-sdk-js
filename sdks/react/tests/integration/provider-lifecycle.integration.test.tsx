import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { useAlitycs, useTrack } from '../../src/hooks';
import { AlitycsProvider } from '../../src/provider';
import { installDom, uninstallDom } from '../helpers';

installDom();
afterAll(uninstallDom);
afterEach(cleanup);

interface CapturedBatch {
  authorization: string | null;
  contentType: string | null;
  body: {
    batchId?: string;
    events?: Array<{ event: string; eventType: string; userId?: string }>;
  };
}

describe('provider lifecycle over the wire', () => {
  test('events queued by consumers are drained by shutdown() on unmount', async () => {
    installDom();

    const batches: CapturedBatch[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        batches.push({
          authorization: request.headers.get('authorization'),
          contentType: request.headers.get('content-type'),
          body: await request.json(),
        });
        return Response.json({ accepted: true });
      },
    });

    try {
      function Consumer(): null {
        const client = useAlitycs();
        // The client exists from the provider's very first client-side render,
        // so children can rely on it even before the provider's own effects run.
        if (!client) throw new Error('useAlitycs returned null during a child render');
        return null;
      }

      function Effects(): null {
        const client = useAlitycs();
        const track = useTrack();
        queueMicrotask(() => {
          client?.identify('usr_lifecycle', { plan: 'pro' });
          track('lifecycle_track', { n: 1 });
          track('lifecycle_second', { n: 2 });
        });
        return null;
      }

      const { unmount } = render(
        createElement(
          AlitycsProvider,
          {
            apiKey: 'pk_test_lifecycle',
            config: {
              endpoint: `http://localhost:${server.port}/events`,
              flushSize: 25,
              flushInterval: 3_600_000,
              maxRetries: 1,
              debug: false,
            },
          },
          createElement(Consumer),
          createElement(Effects)
        )
      );

      // No explicit flush: only the unmount shutdown drains these.
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(batches.length).toBe(0);

      unmount();
      await new Promise(resolve => setTimeout(resolve, 20));

      const delivered = batches.flatMap(batch => batch.body.events ?? []);
      expect(delivered.map(event => event.event).sort()).toEqual(['identify', 'lifecycle_second', 'lifecycle_track']);
      expect(delivered.every(event => event.userId === 'usr_lifecycle')).toBe(true);
      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0].authorization).toBe('Bearer pk_test_lifecycle');
      expect(batches[0].contentType).toBe('application/json');
    } finally {
      server.stop(true);
      cleanup();
    }
  });
});
