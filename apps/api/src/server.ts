import { buildApp } from './app';
import { attachRealtime } from './realtime/hub';

const { app, ctx } = await buildApp();
await attachRealtime(app, ctx);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: ctx.config.PORT, host: '0.0.0.0' });
