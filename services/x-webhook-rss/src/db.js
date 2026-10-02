import { DatabaseSync } from 'node:sqlite';

/**
 * @typedef {object} NewPost
 * @property {string} username   小文字化済み
 * @property {string} link       正規化済み https://x.com/<user>/status/<id>
 * @property {string} text
 * @property {string} createdAt  ISO 8601（UTC, toISOString()）
 * @property {string} receivedAt ISO 8601（UTC, toISOString()）
 *
 * @typedef {object} PostRow
 * @property {string} username
 * @property {string} link
 * @property {string} text
 * @property {string} created_at
 */

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL CHECK (username = lower(username)),
      link        TEXT NOT NULL UNIQUE,
      text        TEXT NOT NULL,
      created_at  TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??.???Z'),
      received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z')
    );
    CREATE INDEX IF NOT EXISTS posts_user_created ON posts (username, created_at DESC);
  `);

  const insert = db.prepare(`
    INSERT INTO posts (username, link, text, created_at, received_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (link) DO NOTHING
  `);
  const listByUser = db.prepare(`
    SELECT username, link, text, created_at FROM posts
    WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const prune = db.prepare(`
    DELETE FROM posts WHERE username = ? AND id NOT IN (
      SELECT id FROM posts WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `);
  const exists = db.prepare('SELECT 1 FROM posts WHERE link = ?');
  const lastReceived = db.prepare('SELECT MAX(received_at) AS t FROM posts');

  return {
    /**
     * @param {NewPost} post
     * @param {number} maxItems
     * @returns {'created' | 'duplicate' | 'pruned'} pruned = 保持件数の範囲外（古すぎる）ため保存しなかった
     */
    addPost(post, maxItems) {
      const result = insert.run(post.username, post.link, post.text, post.createdAt, post.receivedAt);
      if (result.changes === 0) return 'duplicate';
      prune.run(post.username, post.username, maxItems);
      return exists.get(post.link) ? 'created' : 'pruned';
    },
    /** @returns {PostRow[]} */
    listPosts(username, limit) {
      return listByUser.all(username, limit);
    },
    /** @returns {string | null} */
    lastReceivedAt() {
      return lastReceived.get()?.t ?? null;
    },
    close() {
      db.close();
    },
  };
}
