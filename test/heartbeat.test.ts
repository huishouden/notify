import { describe, expect, test } from 'bun:test';
import { heartbeatEvent, sendHeartbeat } from '../src/heartbeat';
import type { RunStats } from '../src/send';

const stats: RunStats = { due: 2, sent: 2, pushed: 3, failed: 0, removed: 1, late: 0, invalid: 0, raced: 0, noDevices: 0, deferred: false };

describe('heartbeat', () => {
  test('carries the counts and no reminder content', () => {
    expect(heartbeatEvent(stats, null, 120, 1_900_000_000_000)).toEqual({ eventType: 'NotifyRun', durationMs: 120, scheduledTime: 1_900_000_000_000, ...stats });
  });

  test('carries a failed run’s error, without addresses', () => {
    const e = heartbeatEvent(null, new Error('no subscription for someone@example.com'), 5, 1);
    expect(e.error).toBe('Error: no subscription for [email]');
    expect(e.sent).toBeUndefined();
  });

  test('sends nothing without the account and key', async () => {
    let called = false;
    const f = (async () => ((called = true), new Response('{}'))) as unknown as typeof fetch;
    expect(await sendHeartbeat({}, { eventType: 'NotifyRun' }, f)).toBe(false);
    expect(called).toBe(false);
  });

  test('posts one event to the Event API', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('{"success":true}'))) as unknown as typeof fetch;
    expect(await sendHeartbeat({ NEW_RELIC_ACCOUNT_ID: '1234567', NEW_RELIC_LICENSE_KEY: 'example-key' }, { eventType: 'NotifyRun', due: 1 }, f)).toBe(true);
    expect(seen[0].url).toBe('https://insights-collector.newrelic.com/v1/accounts/1234567/events');
    expect((seen[0].init.headers as Record<string, string>)['Api-Key']).toBe('example-key');
    expect(JSON.parse(seen[0].init.body as string)).toEqual([{ eventType: 'NotifyRun', due: 1 }]);
  });

  test('a New Relic outage never fails the run', async () => {
    const f = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await sendHeartbeat({ NEW_RELIC_ACCOUNT_ID: '1', NEW_RELIC_LICENSE_KEY: 'k' }, {}, f)).toBe(false);
  });
});
