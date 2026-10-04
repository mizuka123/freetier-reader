// スター付きの記事を見つけて Notion に保存する本体。
//
// 1 回の処理（tick）:
//   1. Miniflux からスター付きの ID をすべて取り、記録と比べて新しいものを送信待ちにする
//      （初回だけは、すでに付いているスターを baseline として記録し、送らない）
//   2. 送信待ちの記事を古い順に Notion へ送る
//
// 二重保存を防ぐため、ページには送信ごとのランダムな「同期 ID」を書き、作成直後にページ ID を記録する。
// 送信の途中で止まった記事は、次の回に同期 ID でページを探し、完成していれば保存済みにし、
// 作りかけ（状態が「保存中」）ならゴミ箱へ移して作り直す。同期 ID が一致しないページには触らない。
import { randomUUID } from 'node:crypto';
import { contentLength } from './blocks.js';
import { MinifluxError } from './miniflux.js';
import { NotionError } from './notion.js';
import { MODES, PROPERTIES, buildPage, checkSchema, completedMode, readPage } from './page.js';

/** この回数だけ失敗したら failed にする */
export const MAX_ATTEMPTS = 8;
// 1 回の処理で送る記事の数の上限（残りは次の回）
const BATCH = 50;

/**
 * 再試行までの待ち時間（1 分・2 分・4 分…最大 6 時間）
 * @param {number} attempts  これまでの失敗回数（1 以上）
 */
export function backoffMs(attempts) {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3600_000);
}

/** NotionError のうち、503 で「書き込みは反映済み」と返ったもの */
const committed = (err) => err instanceof NotionError && typeof err.committedResourceId === 'string';

/**
 * @param {{
 *   db: import('./db.js').Db,
 *   miniflux: import('./miniflux.js').Miniflux,
 *   notion: import('./notion.js').Notion,
 *   config: Pick<import('./config.js').Config, 'notionDatabaseId' | 'minifluxPublicUrl' | 'maxBlocks' | 'fetchFullContent' | 'minContentChars' | 'pollMinutes'>,
 *   now?: () => Date,
 *   log?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   stopping?: () => boolean,
 * }} deps
 */
export function createSyncer(deps) {
  const { db, miniflux, notion, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console;
  const stopping = deps.stopping ?? (() => false);
  /** @type {string | null} */
  let dataSourceId = null;
  let pausedUntil = 0;

  const later = (ms) => new Date(now().getTime() + ms);

  /** Notion のデータベースを確かめ、データソースの ID を得る（成功したら覚えておく） */
  async function ensureDataSource() {
    if (dataSourceId) return dataSourceId;
    const id = await notion.dataSourceId(config.notionDatabaseId);
    const ds = await notion.getDataSource(id);
    const problems = checkSchema(ds?.properties);
    if (problems.length) {
      throw new NotionError(`notion database is not ready: ${problems.join('; ')} (run: node src/cli.js setup-notion)`, { kind: 'fatal' });
    }
    dataSourceId = id;
    return id;
  }

  /** Miniflux のスター付きの記事を記録と突き合わせる */
  async function discover() {
    const ids = await miniflux.starredIds();
    if (!db.initialized()) {
      db.initialize(ids);
      log.log(`initialized: ${ids.length} already-starred entries were recorded as baseline and will not be sent (send them with: node src/cli.js backfill)`);
    } else {
      const added = db.addNew(ids);
      if (added) log.log(`found ${added} newly starred entr${added === 1 ? 'y' : 'ies'}`);
    }
  }

  /**
   * 本文を決める。要約だけの記事（短く、フィードの全文取得がオフ）は、元記事のページから全文の取得を試す。
   * @param {import('./miniflux.js').Entry} entry
   */
  async function chooseContent(entry) {
    const length = contentLength(entry.content);
    if (!config.fetchFullContent || entry.feedCrawler || length >= config.minContentChars || !entry.url) {
      return entry.content;
    }
    try {
      const fetched = await miniflux.fetchContent(entry.id);
      if (contentLength(fetched) > length) {
        log.log(`entry ${entry.id}: using the full content fetched from the original page`);
        return fetched;
      }
    } catch (err) {
      log.warn(`entry ${entry.id}: could not fetch the full content (${err.message}); using the feed content`);
    }
    return entry.content;
  }

  /**
   * 前回の送信で作られたかもしれないページを確かめる。作りかけはゴミ箱へ移す。
   * @param {import('./db.js').EntryRow} row
   * @param {string} ds
   * @returns {Promise<{ pageId: string, mode: import('./page.js').Mode } | null>} 完成したページがあればその情報
   */
  async function recover(row, ds) {
    let pages = [];
    if (row.page_id) {
      try {
        pages = [await notion.getPage(row.page_id)];
      } catch (err) {
        if (!(err instanceof NotionError && err.kind === 'not_found')) throw err;
      }
    } else {
      pages = await notion.query(ds, { property: PROPERTIES.syncId.name, rich_text: { equals: row.sync_id } });
    }
    for (const raw of pages) {
      const page = readPage(raw);
      if (page.inTrash || page.syncId !== row.sync_id) continue;
      const mode = completedMode(page.status);
      if (mode) return { pageId: page.id, mode };
      await notion.trashPage(page.id);
      log.log(`entry ${row.entry_id}: moved an incomplete page from an interrupted attempt to the trash`);
    }
    return null;
  }

  /**
   * 同じ記事のページがすでにあるか（記録を失った・バックアップから戻した場合など）。
   * @param {number} entryId
   * @param {string} ds
   */
  async function existingPage(entryId, ds) {
    const pages = await notion.query(ds, { property: PROPERTIES.entryId.name, number: { equals: entryId } });
    const live = pages.map(readPage).filter((p) => !p.inTrash);
    for (const p of live) {
      const mode = completedMode(p.status);
      if (mode) return { complete: true, pageId: p.id, mode };
    }
    return live.length ? { complete: false, pageId: live[0].id, mode: null } : null;
  }

  /**
   * 1 記事分のページを作る。
   * @param {string} ds
   * @param {import('./miniflux.js').Entry} entry
   * @param {string} content
   * @param {import('./page.js').Mode} mode
   * @param {string} syncId
   */
  async function send(ds, entry, content, mode, syncId) {
    const page = buildPage(entry, content, mode, {
      publicBaseUrl: config.minifluxPublicUrl, maxBlocks: config.maxBlocks, syncId, savedAt: now(),
    });
    let pageId;
    try {
      pageId = await notion.createPage(ds, page.properties, page.chunks[0] ?? []);
    } catch (err) {
      // 503 で「作成は反映済み」と返った場合は、そのページで続ける（作り直すと二重になる）
      if (!committed(err)) throw err;
      pageId = /** @type {NotionError} */ (err).committedResourceId;
    }
    db.setPageId(entry.id, /** @type {string} */ (pageId));
    for (const chunk of page.chunks.slice(1)) {
      try {
        await notion.appendChildren(pageId, chunk);
      } catch (err) {
        if (!committed(err)) throw err;
      }
    }
    try {
      await notion.updatePage(pageId, { [PROPERTIES.status.name]: { select: { name: page.finalStatus } } });
    } catch (err) {
      if (!committed(err)) throw err;
    }
    return { pageId: /** @type {string} */ (pageId), blocks: page.blockCount, converterVersion: page.converterVersion };
  }

  /**
   * 送信待ちの記事を 1 件処理する。
   * @param {import('./db.js').EntryRow} row
   * @param {string} ds
   * @returns {Promise<'continue' | 'stop'>} stop: 送信全体を止める（レート制限・サービス全体の異常）
   */
  async function processEntry(row, ds) {
    const id = row.entry_id;
    try {
      if (row.state === 'sending' && row.sync_id) {
        const recovered = await recover(row, ds);
        if (recovered) {
          db.markDone(id, { pageId: recovered.pageId, mode: recovered.mode, converterVersion: null });
          log.log(`entry ${id}: the page from an interrupted attempt was complete; marked as saved`);
          return 'continue';
        }
      } else {
        const existing = await existingPage(id, ds);
        if (existing?.complete) {
          db.markDone(id, { pageId: existing.pageId, mode: existing.mode, converterVersion: null });
          log.log(`entry ${id}: already saved in Notion; marked as saved`);
          return 'continue';
        }
        if (existing) {
          db.setState(id, 'review', `an incomplete page for this entry exists in Notion but was not created by the current attempt; delete it in Notion and run: node src/cli.js retry ${id}`);
          log.warn(`entry ${id}: found an incomplete page not created by this attempt; left it untouched (state: review)`);
          return 'continue';
        }
      }

      let entry;
      try {
        entry = await miniflux.entry(id);
      } catch (err) {
        if (err instanceof MinifluxError && err.kind === 'not_found') {
          db.setState(id, 'missing', 'the entry no longer exists in Miniflux');
          log.warn(`entry ${id}: no longer exists in Miniflux (state: missing)`);
          return 'continue';
        }
        throw err;
      }
      const content = await chooseContent(entry);

      for (const mode of MODES) {
        db.startSending(id, randomUUID());
        const syncId = /** @type {string} */ (db.get(id)?.sync_id);
        try {
          const result = await send(ds, entry, content, mode, syncId);
          db.markDone(id, { pageId: result.pageId, mode, converterVersion: result.converterVersion });
          db.setMeta('last_notion_ok_at', now().toISOString());
          db.setMeta('notion_error', null);
          log.log(`entry ${id}: saved to Notion (${mode}, ${result.blocks} blocks)`);
          return 'continue';
        } catch (err) {
          // 本文を受け付けなかった場合だけ、作りかけを片付けてから簡単な形で送り直す
          if (!(err instanceof NotionError && err.kind === 'invalid') || mode === 'minimal') throw err;
          const pageId = db.get(id)?.page_id;
          if (pageId) await notion.trashPage(pageId);
          log.warn(`entry ${id}: Notion rejected the ${mode} content (${err.message}); retrying with a simpler page`);
        }
      }
      return 'continue';
    } catch (err) {
      return handleError(id, err);
    }
  }

  /**
   * @param {number} id
   * @param {unknown} err
   * @returns {'continue' | 'stop'}
   */
  function handleError(id, err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotionError && err.kind === 'rate_limited') {
      const waitMs = ((err.retryAfter ?? 60) + 1 + Math.random() * 5) * 1000;
      pausedUntil = now().getTime() + waitMs;
      db.defer(id, { error: message, nextAt: later(waitMs), countAttempt: false });
      log.warn(`notion rate limit: pausing for ${Math.ceil(waitMs / 1000)}s`);
      return 'stop';
    }
    if ((err instanceof NotionError && (err.kind === 'fatal' || err.kind === 'not_found'))
      || (err instanceof MinifluxError && err.kind === 'fatal')) {
      const service = err instanceof NotionError ? 'notion' : 'miniflux';
      const detail = err instanceof NotionError && err.blockLimit
        ? `the Notion workspace has used all of its free blocks (${message})`
        : message;
      db.setMeta(`${service}_error`, detail);
      // 共有の解除やデータベースの削除かもしれないため、次の回にデータベースから確かめ直す
      dataSourceId = null;
      db.defer(id, { error: message, nextAt: later(config.pollMinutes * 60_000), countAttempt: false });
      log.error(`${service} error, sending stopped until the next run: ${detail}`);
      return 'stop';
    }
    const attempts = (db.get(id)?.attempts ?? 0) + 1;
    db.defer(id, { error: message, nextAt: later(backoffMs(attempts)), countAttempt: true });
    if (attempts >= MAX_ATTEMPTS) {
      db.setState(id, 'failed', message);
      log.error(`entry ${id}: giving up after ${attempts} attempts: ${message}`);
    } else {
      log.warn(`entry ${id}: attempt ${attempts} failed, will retry: ${message}`);
    }
    return 'continue';
  }

  return {
    /** 1 回分の処理 */
    async tick() {
      try {
        await discover();
        db.setMeta('last_poll_ok_at', now().toISOString());
        db.setMeta('miniflux_error', null);
      } catch (err) {
        const hint = err instanceof MinifluxError && err.kind === 'fatal' ? ' (check STAR_MINIFLUX_API_KEY)' : '';
        db.setMeta('miniflux_error', `${err.message}${hint}`);
        log.error(`miniflux: could not list starred entries: ${err.message}${hint}`);
        return;
      }
      if (now().getTime() < pausedUntil) return;
      const due = db.due(BATCH);
      if (due.length === 0) return;

      let ds;
      try {
        ds = await ensureDataSource();
      } catch (err) {
        const detail = err instanceof NotionError && err.kind === 'not_found'
          ? `${err.message} (is the database shared with the connection?)`
          : err.message;
        db.setMeta('notion_error', detail);
        log.error(`notion: ${detail}`);
        return;
      }
      for (const row of due) {
        if (stopping()) break;
        if ((await processEntry(row, ds)) === 'stop') break;
      }
    },
  };
}
