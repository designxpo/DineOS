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
const first = setTimeout(maintain, 60_000);
const hourly = setInterval(maintain, 3_600_000);

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
