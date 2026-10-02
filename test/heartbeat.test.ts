import { describe, expect, test } from 'bun:test';
import { heartbeatEvent, monitoredRun, redact, sendHeartbeat } from '../src/heartbeat';
import type { RunStats } from '../src/send';

const stats: RunStats = { due: 2, sent: 2, pushed: 3, failed: 0, removed: 1, late: 0, invalid: 0, raced: 0, noDevices: 0, capped: 0, deferred: false };
const ENV = { NEW_RELIC_ACCOUNT_ID: '1234567', NEW_RELIC_LICENSE_KEY: 'example-key' };

function recorder(response: () => Response | Promise<Response> = () => new Response('{"success":true}')) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => (seen.push({ url, init }), response())) as unknown as typeof fetch;
  return { seen, f };
}

describe('heartbeat event', () => {
  test('carries the listed counts only', () => {
    const extra = { ...stats, hosts: ['push.example.com'] } as unknown as RunStats;
    expect(heartbeatEvent(extra, null, 120, 1_900_000_000_000)).toEqual({ eventType: 'NotifyRun', durationMs: 120, scheduledTime: 1_900_000_000_000, ...stats });
  });

  test('carries a failed run’s error, without addresses or household paths', () => {
    const e = heartbeatEvent(null, new Error('no subscription for someone@example.com in households/h-example-1/pushSubscriptions'), 5, 1);
    expect(e.error).toBe('Error: no subscription for [email] in households/[id]/pushSubscriptions');
    expect(e.sent).toBeUndefined();
  });

  test('redacts Firestore document names', () => {
    expect(redact('NOT_FOUND: projects/demo-project/databases/(default)/documents/households/h1/reminders/r1 missing')).toBe('NOT_FOUND: [document] missing');
  });
});

describe('sendHeartbeat', () => {
  test('sends nothing without the account and key', async () => {
    const { seen, f } = recorder();
    expect(await sendHeartbeat({}, { eventType: 'NotifyRun' }, f)).toEqual({ sent: false, reason: 'unconfigured' });
    expect(seen).toHaveLength(0);
  });

  test('posts one event to the Event API', async () => {
    const { seen, f } = recorder();
    expect(await sendHeartbeat(ENV, { eventType: 'NotifyRun', due: 1 }, f)).toEqual({ sent: true });
    expect(seen[0].url).toBe('https://insights-collector.newrelic.com/v1/accounts/1234567/events');
    expect((seen[0].init.headers as Record<string, string>)['Api-Key']).toBe('example-key');
    expect(JSON.parse(seen[0].init.body as string)).toEqual([{ eventType: 'NotifyRun', due: 1 }]);
  });

  test('says why it failed instead of throwing', async () => {
    expect(await sendHeartbeat(ENV, {}, recorder(() => new Response('', { status: 403 })).f)).toEqual({ sent: false, reason: 'http', status: 403 });
    const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await sendHeartbeat(ENV, {}, down)).toEqual({ sent: false, reason: 'network', message: 'down' });
  });
});

describe('monitoredRun', () => {
  const clock = () => {
    let t = 1000;
    return () => (t += 50);
  };

  test('a finished run sends its counts', async () => {
    const { seen, f } = recorder();
    const lines: string[] = [];
    expect(await monitoredRun(ENV, 7, { run: async () => stats, fetch: f, now: clock(), log: (l) => lines.push(l) })).toEqual(stats);
    expect(JSON.parse(seen[0].init.body as string)[0]).toMatchObject({ eventType: 'NotifyRun', due: 2, pushed: 3, scheduledTime: 7, durationMs: 50 });
    expect(lines).toEqual([JSON.stringify(stats)]);
  });

  test('a run that throws still sends a heartbeat, then rethrows the same error', async () => {
    const { seen, f } = recorder();
    const boom = new Error('token exchange failed');
    await expect(monitoredRun(ENV, 7, { run: async () => { throw boom; }, fetch: f, now: clock(), log: () => {} })).rejects.toBe(boom);
    expect(JSON.parse(seen[0].init.body as string)[0].error).toBe('Error: token exchange failed');
  });

  test('a heartbeat that could not be sent is logged; an unconfigured one is not', async () => {
    const lines: string[] = [];
    await monitoredRun(ENV, 7, { run: async () => stats, fetch: recorder(() => new Response('', { status: 403 })).f, now: clock(), log: (l) => lines.push(l) });
    expect(lines[1]).toBe('heartbeat not sent: {"sent":false,"reason":"http","status":403}');
    const quiet: string[] = [];
    await monitoredRun({}, 7, { run: async () => stats, fetch: recorder().f, now: clock(), log: (l) => quiet.push(l) });
    expect(quiet).toHaveLength(1);
  });
});
