import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createLinkPreview, createPreviewWorker } from './linkpreview.js';

process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection:', err);
  process.exit(1);
});

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const worker = config.linkPreview
  ? createPreviewWorker({ db, preview: createLinkPreview() })
  : null;
const server = createServer(createApp({ db, config, onPostCreated: () => worker?.kick() }));
server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, () => {
  console.log(`x-webhook-rss listening on :${config.port} (allowed users: ${[...config.allowedUsers].join(', ') || 'any'}, link preview: ${config.linkPreview})`);
  // 起動前に届いていた投稿（この機能を入れる前の投稿を含む）の画像も取得する
  worker?.kick();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
