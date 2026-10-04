import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createMiniflux } from './miniflux.js';
import { createNotion } from './notion.js';
import { statusReport } from './status.js';
import { createSyncer } from './sync.js';

process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection:', err);
  process.exit(1);
});

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
let stopping = false;
const syncer = createSyncer({
  db,
  config,
  miniflux: createMiniflux({ baseUrl: config.minifluxUrl, apiKey: config.minifluxApiKey }),
  notion: createNotion({ token: config.notionToken }),
  stopping: () => stopping,
});

// /healthz（プロセスが動いているか）と /status（同期が正常か）。コンテナの中（127.0.0.1）からだけ使う
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    const report = statusReport(db, config, new Date());
    res.writeHead(report.ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(`${JSON.stringify(report)}\n`);
    return;
  }
  res.writeHead(404).end();
});

/** @type {Promise<void> | null} */
let running = null;
/** @type {NodeJS.Timeout | undefined} */
let timer;
function schedule(delayMs) {
  timer = setTimeout(() => {
    running = syncer.tick()
      .catch((err) => console.error('tick failed:', err))
      .finally(() => {
        running = null;
        if (!stopping) schedule(config.pollMinutes * 60_000);
      });
  }, delayMs);
}

server.listen(config.port, '127.0.0.1', () => {
  console.log(`star-to-notion started (every ${config.pollMinutes} min, full content: ${config.fetchFullContent})`);
  schedule(0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopping = true;
    clearTimeout(timer);
    // 処理中の記事は 1 件分だけ終わるのを待つ（途中で止まっても、次の起動時に同期 ID で確かめて続きから進める）
    await running;
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
