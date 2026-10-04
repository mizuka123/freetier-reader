import { DatabaseSync } from 'node:sqlite';

// 記事ごとの送信状況を SQLite に記録する。
// スキーマの変更は「列・表・索引の追加」だけにする（更新に失敗して古いコードに戻しても、新しい DB を読めるように）。

/**
 * 記事の状態
 *   baseline: 導入時にすでにスターが付いていた（送らない。cli.js backfill で pending にできる）
 *   pending:  送信待ち
 *   sending:  送信を始めた（Notion にページが作られているかもしれない。次は同期 ID で確かめてから進める）
 *   done:     保存済み
 *   failed:   再試行の上限に達した
 *   missing:  Miniflux から記事が消えていた（フィードの削除など）
 *   review:   Notion に同じ記事の作りかけのページがあり、このサービスの記録と一致しない（手で確認する）
 *   ignored:  failed / missing / review を確認済みにしたもの（cli.js ack）
 * @typedef {'baseline' | 'pending' | 'sending' | 'done' | 'failed' | 'missing' | 'review' | 'ignored'} EntryState
 *
 * @typedef {object} EntryRow
 * @property {number} entry_id
 * @property {EntryState} state
 * @property {string | null} sync_id   送信ごとのランダムな ID（Notion のページにも書く）
 * @property {string | null} page_id
 * @property {number} attempts
 * @property {string | null} next_attempt_at
 * @property {string | null} last_error
 * @property {string | null} mode      保存した形（full / plain / minimal）
 * @property {string} first_seen_at
 * @property {string} updated_at
 * @property {string | null} done_at
 */

export const STATES = ['baseline', 'pending', 'sending', 'done', 'failed', 'missing', 'review', 'ignored'];
// 監視で異常として扱う状態（cli.js ack で ignored にするまで）
export const PROBLEM_STATES = ['failed', 'missing', 'review'];
const SCHEMA_VERSION = 1;

/**
 * @param {string} path
 * @param {() => Date} [now]
 */
export function openDb(path, now = () => new Date()) {
  const db = new DatabaseSync(path);
  const iso = () => now().toISOString();
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    -- created_at / initialized_at / last_poll_ok_at / last_notion_ok_at / miniflux_error / notion_error
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      entry_id          INTEGER PRIMARY KEY,
      state             TEXT NOT NULL CHECK (state IN (${STATES.map((s) => `'${s}'`).join(', ')})),
      sync_id           TEXT,
      page_id           TEXT,
      attempts          INTEGER NOT NULL DEFAULT 0,
      next_attempt_at   TEXT,
      last_error        TEXT,
      mode              TEXT,
      converter_version INTEGER,
      first_seen_at     TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      done_at           TEXT
    );
    CREATE INDEX IF NOT EXISTS entries_state ON entries (state, next_attempt_at);
  `);
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  // version > SCHEMA_VERSION は新しい版で作られた DB。変更は追加だけなので、そのまま読み書きできる

  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const deleteMeta = db.prepare('DELETE FROM meta WHERE key = ?');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run('created_at', iso());

  const insert = db.prepare(`
    INSERT INTO entries (entry_id, state, first_seen_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (entry_id) DO NOTHING
  `);
  const get = db.prepare('SELECT * FROM entries WHERE entry_id = ?');
  const due = db.prepare(`
    SELECT * FROM entries
    WHERE state IN ('pending', 'sending') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY first_seen_at, entry_id LIMIT ?
  `);
  const update = (sql) => db.prepare(`UPDATE entries SET ${sql}, updated_at = @now WHERE entry_id = @id`);
  const startSending = update(`state = 'sending', sync_id = @syncId, page_id = NULL`);
  const setPageId = update('page_id = @pageId');
  const markDone = update(`state = 'done', page_id = @pageId, mode = @mode, converter_version = @converterVersion,
    next_attempt_at = NULL, last_error = NULL, done_at = @now`);
  const defer = update(`attempts = attempts + @increment, next_attempt_at = @nextAt, last_error = @error,
    state = CASE WHEN sync_id IS NULL THEN 'pending' ELSE 'sending' END`);
  const setState = update('state = @state, last_error = @error, next_attempt_at = NULL');
  const reset = update(`state = 'pending', attempts = 0, sync_id = NULL, page_id = NULL, next_attempt_at = NULL, last_error = NULL`);

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    /** @param {string} key */
    getMeta(key) {
      const row = getMeta.get(key);
      return row === undefined ? null : String(row.value);
    },
    /**
     * @param {string} key
     * @param {string | null} value  null で削除
     */
    setMeta(key, value) {
      if (value === null) deleteMeta.run(key);
      else setMeta.run(key, value);
    },

    /** 初回の取り込みが済んでいるか */
    initialized() {
      return getMeta.get('initialized_at') !== undefined;
    },

    /**
     * 導入時にスターが付いている記事を baseline として記録する（送らない）。
     * @param {number[]} ids
     */
    initialize(ids) {
      const t = iso();
      transaction(() => {
        for (const id of ids) insert.run(id, 'baseline', t, t);
        setMeta.run('initialized_at', t);
      });
    },

    /**
     * 新しくスターが付いた記事を送信待ちにする。記録済みの記事（状態を問わない）は変えない。
     * @param {number[]} ids
     * @returns {number} 追加した件数
     */
    addNew(ids) {
      const t = iso();
      return transaction(() => {
        let added = 0;
        for (const id of ids) added += Number(insert.run(id, 'pending', t, t).changes);
        return added;
      });
    },

    /**
     * @param {number} id
     * @returns {EntryRow | undefined}
     */
    get(id) {
      return /** @type {EntryRow | undefined} */ (get.get(id));
    },

    /**
     * 今送るべき記事（送信待ちと、送信途中で止まったもの）を古い順に返す。
     * @param {number} limit
     * @returns {EntryRow[]}
     */
    due(limit) {
      return /** @type {EntryRow[]} */ (/** @type {unknown} */ (due.all(iso(), limit)));
    },

    /**
     * @param {number} id
     * @param {string} syncId
     */
    startSending(id, syncId) {
      startSending.run({ id, syncId, now: iso() });
    },

    /**
     * @param {number} id
     * @param {string} pageId
     */
    setPageId(id, pageId) {
      setPageId.run({ id, pageId, now: iso() });
    },

    /**
     * @param {number} id
     * @param {{ pageId: string, mode: string | null, converterVersion: number | null }} info
     */
    markDone(id, info) {
      markDone.run({ id, now: iso(), ...info });
    },

    /**
     * 後で再試行する。
     * @param {number} id
     * @param {{ error: string, nextAt: Date, countAttempt: boolean }} info
     */
    defer(id, info) {
      defer.run({ id, now: iso(), error: info.error, nextAt: info.nextAt.toISOString(), increment: info.countAttempt ? 1 : 0 });
    },

    /**
     * @param {number} id
     * @param {'failed' | 'missing' | 'review' | 'ignored'} state
     * @param {string | null} error
     */
    setState(id, state, error) {
      setState.run({ id, state, error, now: iso() });
    },

    /**
     * 送信待ちに戻す（cli.js retry）。
     * @param {number} id
     */
    reset(id) {
      reset.run({ id, now: iso() });
    },

    /** 状態ごとの件数 */
    counts() {
      /** @type {Record<string, number>} */
      const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
      for (const row of db.prepare('SELECT state, COUNT(*) AS n FROM entries GROUP BY state').all()) {
        counts[String(row.state)] = Number(row.n);
      }
      return counts;
    },

    /**
     * まだ送れていない記事のうち、いちばん古く見つけた時刻
     * @returns {string | null}
     */
    oldestUnsent() {
      const row = db.prepare("SELECT MIN(first_seen_at) AS t FROM entries WHERE state IN ('pending', 'sending')").get();
      return row?.t == null ? null : String(row.t);
    },

    /**
     * @param {string[]} states
     * @param {number} limit
     * @returns {EntryRow[]}
     */
    list(states, limit) {
      const placeholders = states.map(() => '?').join(', ');
      return /** @type {EntryRow[]} */ (/** @type {unknown} */ (db.prepare(
        `SELECT * FROM entries WHERE state IN (${placeholders}) ORDER BY updated_at DESC, entry_id DESC LIMIT ?`,
      ).all(...states, limit)));
    },

    /**
     * baseline の記事を、新しい（ID が大きい）ものから送信待ちにする（cli.js backfill）。
     * @param {number} limit
     * @returns {number} 送信待ちにした件数
     */
    backfill(limit) {
      return Number(db.prepare(`
        UPDATE entries SET state = 'pending', updated_at = ?
        WHERE entry_id IN (SELECT entry_id FROM entries WHERE state = 'baseline' ORDER BY entry_id DESC LIMIT ?)
      `).run(iso(), limit).changes);
    },

    close() {
      db.close();
    },
  };
}

/** @typedef {ReturnType<typeof openDb>} Db */
