import { waitUntil } from '@vercel/functions';
import { buildApp } from './app';
import { runMaintenance } from './lib/maintenance';
import { runTalkoJobs } from './modules/integrations/outbox';
import { attachRealtime } from './realtime/hub';

const { app, ctx } = await buildApp();
await attachRealtime(app, ctx);

// Hourly housekeeping; an advisory lock keeps it to one node at a time.
const maintain = () =>
  runMaintenance(ctx.adminDb)
    .then((r) => r && app.log.info({ maintenance: r }, 'maintenance done'))
    .catch((err) => app.log.error({ err }, 'maintenance failed'));
// Talko AI: booking reminders and message retries, every minute. New messages go out right after
// the commit that made them; this catches retries and anything that missed that moment.
const talko = () =>
  runTalkoJobs(ctx)
    .then((r) => (r.reminders || r.sent || r.dead) && app.log.info({ talko: r }, 'talko jobs done'))
    .catch((err) => app.log.error({ err }, 'talko jobs failed'));
let first: NodeJS.Timeout | undefined;
let hourly: NodeJS.Timeout | undefined;
let everyMinute: NodeJS.Timeout | undefined;
if (process.env.VERCEL) {
  // No always-on process on Vercel: traffic runs the job at most hourly per instance (restaurants
  // are busy exactly when it matters), and the daily cron in vercel.json covers quiet days.
  let due = Date.now() + 60_000;
  let talkoDue = Date.now() + 60_000;
  app.addHook('onResponse', async () => {
    if (Date.now() >= talkoDue) {
      talkoDue = Date.now() + 60_000;
      waitUntil(talko());
    }
    if (Date.now() < due) return;
    due = Date.now() + 3_600_000;
    waitUntil(maintain());
  });
} else {
  first = setTimeout(maintain, 60_000);
  hourly = setInterval(maintain, 3_600_000);
  everyMinute = setInterval(talko, 60_000);
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  clearTimeout(first);
  clearInterval(hourly);
  clearInterval(everyMinute);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Not awaited: Vercel's runtime stubs listen() to take the server and never resolves it, so
// awaiting here would keep this module from ever finishing loading.
app.listen({ port: ctx.config.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error({ err }, 'could not start listening');
  process.exit(1);
});
