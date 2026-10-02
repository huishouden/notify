import { run, type Env } from './send';

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      run(env, controller.scheduledTime, (input, init) => fetch(input, init)).then((stats) => console.log(JSON.stringify(stats))),
    );
  },

  // Nothing to see over HTTP: reminders are only read on the schedule.
  async fetch(): Promise<Response> {
    return new Response('huishouden notify: sends due reminders every 5 minutes\n', { headers: { 'Content-Type': 'text/plain' } });
  },
} satisfies ExportedHandler<Env>;
