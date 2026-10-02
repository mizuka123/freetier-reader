import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';

function loadConfig(env) {
  const webhookToken = env.X_WEBHOOK_TOKEN ?? '';
  if (webhookToken.length < 32) {
    throw new Error('X_WEBHOOK_TOKEN must be at least 32 characters (run scripts/init.sh)');
  }
  const tzOffset = env.X_IFTTT_TZ_OFFSET ?? '+09:00';
  if (!/^[+-]\d{2}:\d{2}$/.test(tzOffset)) {
    throw new Error('X_IFTTT_TZ_OFFSET must look like +09:00');
  }
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DB_PATH ?? '/data/x-webhook-rss.db',
    webhookToken,
    tzOffset,
    allowedUsers: new Set(
      (env.X_ALLOWED_USERS ?? '').split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
    ),
    maxItems: Number(env.X_MAX_ITEMS ?? 200),
    publicBaseUrl: (env.X_FEED_BASE_URL ?? 'http://x-webhook-rss:8080').replace(/\/$/, ''),
  };
}

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const server = createServer(createApp({ db, config }));

server.listen(config.port, () => {
  console.log(`x-webhook-rss listening on :${config.port} (allowed users: ${[...config.allowedUsers].join(', ') || 'any'})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
