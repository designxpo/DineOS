import { waitUntil } from '@vercel/functions';
import { buildApp } from './app';
import { runMaintenance } from './lib/maintenance';
import { attachRealtime } from './realtime/hub';

const { app, ctx } = await buildApp();
await attachRealtime(app, ctx);

// Hourly housekeeping; an advisory lock keeps it to one node at a time.
const maintain = () =>
  runMaintenance(ctx.adminDb)
    .then((r) => r && app.log.info({ maintenance: r }, 'maintenance done'))
    .catch((err) => app.log.error({ err }, 'maintenance failed'));
let first: NodeJS.Timeout | undefined;
let hourly: NodeJS.Timeout | undefined;
if (process.env.VERCEL) {
  // No always-on process on Vercel: traffic runs the job at most hourly per instance (restaurants
  // are busy exactly when it matters), and the daily cron in vercel.json covers quiet days.
  let due = Date.now() + 60_000;
  app.addHook('onResponse', async () => {
    if (Date.now() < due) return;
    due = Date.now() + 3_600_000;
    waitUntil(maintain());
  });
} else {
  first = setTimeout(maintain, 60_000);
  hourly = setInterval(maintain, 3_600_000);
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  clearTimeout(first);
  clearInterval(hourly);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: ctx.config.PORT, host: '0.0.0.0' });
