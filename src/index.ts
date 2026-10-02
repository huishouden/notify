import { run, type Env, type RunStats } from './send';
import { heartbeatEvent, sendHeartbeat, type HeartbeatEnv } from './heartbeat';

export default {
  async scheduled(controller: ScheduledController, env: Env & HeartbeatEnv, ctx: ExecutionContext): Promise<void> {
    const started = Date.now();
    ctx.waitUntil(
      (async () => {
        let stats: RunStats | null = null;
        let error: unknown = null;
        try {
          stats = await run(env, controller.scheduledTime, (input, init) => fetch(input, init));
          console.log(JSON.stringify(stats));
        } catch (e) {
          error = e;
        }
        await sendHeartbeat(env, heartbeatEvent(stats, error, Date.now() - started, controller.scheduledTime));
        // Rethrown so Cloudflare still records the run as failed.
        if (error) throw error;
      })(),
    );
  },

  // Nothing to see over HTTP: reminders are only read on the schedule.
  async fetch(): Promise<Response> {
    return new Response('huishouden notify: sends due reminders every 5 minutes\n', { headers: { 'Content-Type': 'text/plain' } });
  },
} satisfies ExportedHandler<Env & HeartbeatEnv>;
