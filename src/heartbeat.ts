import type { RunStats } from './send';

/**
 * One `NotifyRun` event per run to New Relic's Event API, so an alert fires when runs stop (no
 * event for 20 minutes) or fail. Only counts and the error message: no reminder text, households
 * or addresses. Without NEW_RELIC_ACCOUNT_ID and the NEW_RELIC_LICENSE_KEY secret nothing is sent.
 * Uses one of the subrequests the run's budget leaves spare.
 */
export interface HeartbeatEnv {
  NEW_RELIC_ACCOUNT_ID?: string;
  /** Secret: a New Relic ingest (license) key. */
  NEW_RELIC_LICENSE_KEY?: string;
}

export function heartbeatEvent(stats: RunStats | null, error: unknown, durationMs: number, scheduledTime: number): Record<string, string | number | boolean> {
  const event: Record<string, string | number | boolean> = { eventType: 'NotifyRun', durationMs, scheduledTime };
  if (stats) for (const [k, v] of Object.entries(stats)) event[k] = v;
  if (error) event.error = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').slice(0, 300);
  return event;
}

export async function sendHeartbeat(env: HeartbeatEnv, event: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!env.NEW_RELIC_ACCOUNT_ID || !env.NEW_RELIC_LICENSE_KEY) return false;
  try {
    const res = await fetchImpl(`https://insights-collector.newrelic.com/v1/accounts/${env.NEW_RELIC_ACCOUNT_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': env.NEW_RELIC_LICENSE_KEY },
      body: JSON.stringify([event]),
    });
    return res.ok;
  } catch {
    return false;
  }
}
