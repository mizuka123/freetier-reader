import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL,
      link        TEXT NOT NULL UNIQUE,
      text        TEXT NOT NULL,
      embed       TEXT,
      created_at  TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_user_created ON posts (username, created_at DESC);
  `);

  const insert = db.prepare(`
    INSERT INTO posts (username, link, text, embed, created_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (link) DO NOTHING
  `);
  const listByUser = db.prepare(`
    SELECT username, link, text, embed, created_at FROM posts
    WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const prune = db.prepare(`
    DELETE FROM posts WHERE username = ? AND id NOT IN (
      SELECT id FROM posts WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `);
  const lastReceived = db.prepare('SELECT MAX(received_at) AS t FROM posts');

  return {
    /** @returns {boolean} 新規に保存したら true（重複なら false） */
    addPost(post, maxItems) {
      const result = insert.run(
        post.username, post.link, post.text, post.embed ?? null,
        post.createdAt, post.receivedAt,
      );
      prune.run(post.username, post.username, maxItems);
      return result.changes > 0;
    },
    listPosts(username, limit) {
      return listByUser.all(username, limit);
    },
    lastReceivedAt() {
      return lastReceived.get()?.t ?? null;
    },
    close() {
      db.close();
    },
  };
}
