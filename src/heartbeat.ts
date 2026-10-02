import type { RunStats } from './send';

/**
 * One `NotifyRun` event per run to New Relic's Event API, so alerts fire when runs stop (no event
 * for 20 minutes), a run throws, or pushes keep failing. Only the counts below and a redacted error
 * message: no reminder text, households or addresses. Without NEW_RELIC_ACCOUNT_ID and the
 * NEW_RELIC_LICENSE_KEY secret nothing is sent.
 */
export interface HeartbeatEnv {
  NEW_RELIC_ACCOUNT_ID?: string;
  /** Secret: a New Relic ingest (license) key. */
  NEW_RELIC_LICENSE_KEY?: string;
}

/**
 * The heartbeat uses one subrequest outside the run's budget; `SUBREQUEST_BUDGET` (45) leaves it
 * room under Cloudflare's 50.
 */
export const HEARTBEAT_SUBREQUESTS = 1;

/** Counts sent with each run. A new `RunStats` field is not sent until it is listed here. */
const COUNTS = ['due', 'sent', 'pushed', 'failed', 'removed', 'late', 'invalid', 'raced', 'noDevices', 'deferred'] as const satisfies readonly (keyof RunStats)[];

/** An error message without addresses or Firestore document paths (which name households). */
export function redact(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/projects\/[^\s"']*\/documents\/[^\s"']*/g, '[document]')
    .replace(/households\/[^/\s"']+/g, 'households/[id]')
    .slice(0, 300);
}

export function heartbeatEvent(stats: RunStats | null, error: unknown, durationMs: number, scheduledTime: number): Record<string, string | number | boolean> {
  const event: Record<string, string | number | boolean> = { eventType: 'NotifyRun', durationMs, scheduledTime };
  if (stats) for (const k of COUNTS) event[k] = stats[k];
  if (error) event.error = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  return event;
}

export type HeartbeatResult = { sent: true } | { sent: false; reason: 'unconfigured' } | { sent: false; reason: 'http'; status: number } | { sent: false; reason: 'network'; message: string };

export async function sendHeartbeat(env: HeartbeatEnv, event: Record<string, unknown>, fetchImpl: typeof fetch): Promise<HeartbeatResult> {
  if (!env.NEW_RELIC_ACCOUNT_ID || !env.NEW_RELIC_LICENSE_KEY) return { sent: false, reason: 'unconfigured' };
  try {
    const res = await fetchImpl(`https://insights-collector.newrelic.com/v1/accounts/${env.NEW_RELIC_ACCOUNT_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': env.NEW_RELIC_LICENSE_KEY },
      body: JSON.stringify([event]),
    });
    return res.ok ? { sent: true } : { sent: false, reason: 'http', status: res.status };
  } catch (e) {
    // Reported to the caller, never thrown: a New Relic outage must not fail a run.
    return { sent: false, reason: 'network', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Runs once and sends its heartbeat, whether the run finished or threw. A run's error is rethrown
 * after the heartbeat so Cloudflare still records the run as failed; a heartbeat that couldn't be
 * sent is logged, so a silent alert with a live Worker can be told apart from a dead one.
 */
export async function monitoredRun(
  env: HeartbeatEnv,
  scheduledTime: number,
  deps: { run: () => Promise<RunStats>; fetch: typeof fetch; now: () => number; log: (line: string) => void },
): Promise<RunStats> {
  const started = deps.now();
  let stats: RunStats | null = null;
  let error: unknown = null;
  try {
    stats = await deps.run();
    deps.log(JSON.stringify(stats));
  } catch (e) {
    error = e;
  }
  const result = await sendHeartbeat(env, heartbeatEvent(stats, error, deps.now() - started, scheduledTime), deps.fetch);
  if (!result.sent && result.reason !== 'unconfigured') deps.log(`heartbeat not sent: ${JSON.stringify(result)}`);
  if (error) throw error;
  return stats!;
}
