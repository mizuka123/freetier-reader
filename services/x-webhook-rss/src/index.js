import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection:', err);
  process.exit(1);
});

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
const server = createServer(createApp({ db, config }));
server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

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
