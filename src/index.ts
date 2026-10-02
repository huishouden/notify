import { run, type Env } from './send';
import { monitoredRun, type HeartbeatEnv } from './heartbeat';

export default {
  async scheduled(controller: ScheduledController, env: Env & HeartbeatEnv, ctx: ExecutionContext): Promise<void> {
    const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
    ctx.waitUntil(
      monitoredRun(env, controller.scheduledTime, {
        run: () => run(env, controller.scheduledTime, fetchImpl),
        fetch: fetchImpl,
        now: () => Date.now(),
        log: (line) => console.log(line),
      }),
    );
  },

  // Nothing to see over HTTP: reminders are only read on the schedule.
  async fetch(): Promise<Response> {
    return new Response('huishouden notify: sends due reminders every 5 minutes\n', { headers: { 'Content-Type': 'text/plain' } });
  },
} satisfies ExportedHandler<Env & HeartbeatEnv>;
