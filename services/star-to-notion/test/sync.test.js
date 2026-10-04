import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { MinifluxError } from '../src/miniflux.js';
import { PROPERTIES, STATUS } from '../src/page.js';
import { statusReport } from '../src/status.js';
import { MAX_ATTEMPTS, backoffMs, createSyncer } from '../src/sync.js';
import { FakeMiniflux, FakeNotion, notionErrors } from './fakes.js';
import { assertValidBlocks } from './notion-limits.js';

const CONFIG = {
  notionDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
  minifluxPublicUrl: 'https://rss.example.com',
  maxBlocks: 1000,
  fetchFullContent: true,
  minContentChars: 500,
  pollMinutes: 5,
};
const quiet = { log() {}, warn() {}, error() {} };

/** @param {Partial<typeof CONFIG>} [config] */
async function setup(config = {}) {
  const clock = { now: new Date('2026-10-04T00:00:00Z') };
  const db = openDb(':memory:', () => clock.now);
  const miniflux = new FakeMiniflux();
  const notion = new FakeNotion();
  const syncer = createSyncer({ db, miniflux, notion, config: { ...CONFIG, ...config }, now: () => clock.now, log: quiet });
  const advance = (ms) => { clock.now = new Date(clock.now.getTime() + ms); };
  // 導入時（スターなし）の初回の処理を済ませておく
  await syncer.tick();
  return { db, miniflux, notion, syncer, advance };
}

const prop = (page, key) => page.properties[PROPERTIES[key].name];
const statusOf = (page) => prop(page, 'status').select.name;

test('already-starred entries become baseline and are not sent', async () => {
  const clock = { now: new Date('2026-10-04T00:00:00Z') };
  const db = openDb(':memory:', () => clock.now);
  const miniflux = new FakeMiniflux();
  const notion = new FakeNotion();
  miniflux.add(1).add(2).star(1, 2);
  const syncer = createSyncer({ db, miniflux, notion, config: CONFIG, now: () => clock.now, log: quiet });
  await syncer.tick();
  assert.equal(db.counts().baseline, 2);
  assert.equal(notion.pages.size, 0);
  // backfill すると新しいものから送られる
  assert.equal(db.backfill(1), 1);
  await syncer.tick();
  assert.equal(notion.live().length, 1);
  assert.equal(prop(notion.live()[0], 'entryId').number, 2);
});

test('a newly starred entry is saved with properties and content', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  miniflux.add(10, { content: '<h2>Heading</h2><p>Body <a href="https://e.com">link</a></p>' + '<p>x</p>'.repeat(300) }).star(10);
  await syncer.tick();
  const [page] = notion.live();
  assert.equal(prop(page, 'title').title[0].text.content, 'Title 10');
  assert.equal(prop(page, 'url').url, 'https://news.example.com/10');
  assert.equal(prop(page, 'feed').select.name, 'Example， News');
  assert.equal(prop(page, 'published').date.start, '2026-10-01T00:00:00.000Z');
  assert.equal(prop(page, 'saved').date.start, '2026-10-04T00:00:00.000Z');
  assert.equal(prop(page, 'entryId').number, 10);
  assert.equal(statusOf(page), STATUS.full);
  assert.equal(page.children[0].type, 'heading_2');
  assert.deepEqual(page.children.slice(-2).map((b) => b.type), ['divider', 'bookmark']);
  assert.equal(page.children.length, 2 + 300 + 2);
  assertValidBlocks(page.children);
  // 100 ブロックを超える分は追記で送る
  assert.ok(notion.calls.filter((c) => c === 'appendChildren').length >= 3);
  const row = db.get(10);
  assert.equal(row.state, 'done');
  assert.equal(row.page_id, page.id);
  assert.equal(row.mode, 'full');
  assert.ok(db.getMeta('last_notion_ok_at'));
});

test('unstarring keeps the page, and starring again does not send it twice', async () => {
  const { miniflux, notion, syncer } = await setup();
  miniflux.add(1).star(1);
  await syncer.tick();
  miniflux.unstar(1);
  await syncer.tick();
  miniflux.star(1);
  await syncer.tick();
  assert.equal(notion.pages.size, 1);
  assert.equal(notion.live().length, 1);
});

test('rejected content is resent as plain text, then without content', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  miniflux.add(1).star(1);
  notion.fail('createPage', notionErrors.invalid);
  await syncer.tick();
  assert.equal(notion.live().length, 1);
  assert.equal(statusOf(notion.live()[0]), STATUS.plain);
  assert.equal(db.get(1).mode, 'plain');

  miniflux.add(2).star(2);
  notion.fail('createPage', notionErrors.invalid);
  notion.fail('createPage', notionErrors.invalid);
  await syncer.tick();
  const page = notion.live().find((p) => prop(p, 'entryId').number === 2);
  assert.equal(statusOf(page), STATUS.minimal);
  assert.equal(page.children.at(-1).type, 'bookmark');
});

test('a partially appended page is trashed before resending in a simpler form', async () => {
  const { miniflux, notion, syncer } = await setup();
  miniflux.add(1, { content: '<p>x</p>'.repeat(250) }).star(1);
  notion.fail('appendChildren', notionErrors.invalid);
  await syncer.tick();
  const pages = [...notion.pages.values()];
  assert.equal(pages.length, 2);
  assert.equal(pages[0].in_trash, true);
  assert.equal(statusOf(notion.live()[0]), STATUS.plain);
});

test('an uncertain create is recovered on the next attempt without duplicates', async () => {
  const { db, miniflux, notion, syncer, advance } = await setup();
  miniflux.add(1).star(1);
  // 作成は反映されたが、応答が届かなかった
  notion.fail('createPage', notionErrors.uncertain, { commit: true });
  await syncer.tick();
  assert.equal(db.get(1).state, 'sending');
  assert.equal(db.get(1).attempts, 1);
  // 待ち時間が過ぎるまでは再試行しない
  await syncer.tick();
  assert.equal(notion.pages.size, 1);
  advance(backoffMs(1));
  await syncer.tick();
  assert.equal(db.get(1).state, 'done');
  // 作りかけ（保存中）はゴミ箱へ移し、作り直す
  assert.equal(notion.pages.size, 2);
  assert.equal(notion.live().length, 1);
  assert.equal(statusOf(notion.live()[0]), STATUS.full);
});

test('if the page was completed before the record was updated, it is adopted', async () => {
  const { db, miniflux, notion, syncer, advance } = await setup();
  miniflux.add(1).star(1);
  notion.fail('updatePage', notionErrors.uncertain, { commit: true });
  await syncer.tick();
  assert.equal(db.get(1).state, 'sending');
  advance(backoffMs(1));
  await syncer.tick();
  assert.equal(db.get(1).state, 'done');
  assert.equal(notion.pages.size, 1);
});

test('503 with a committed page continues with that page', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  miniflux.add(1, { content: '<p>x</p>'.repeat(150) }).star(1);
  notion.fail('createPage', () => notionErrors.committed('page-1'), { commit: true });
  await syncer.tick();
  assert.equal(notion.pages.size, 1);
  assert.equal(db.get(1).state, 'done');
  assert.equal(statusOf(notion.live()[0]), STATUS.full);
  assert.equal(notion.live()[0].children.length, 150 + 2);
});

test('pages whose sync id does not match are never trashed', async () => {
  const { db, miniflux, notion, syncer, advance } = await setup();
  miniflux.add(1).star(1);
  notion.fail('createPage', notionErrors.uncertain);
  await syncer.tick();
  // 同じ記事の、別の（このサービスの記録にない）作りかけのページ
  await notion.createPage('ds-1', {
    [PROPERTIES.entryId.name]: { number: 1 },
    [PROPERTIES.status.name]: { select: { name: STATUS.sending } },
    [PROPERTIES.syncId.name]: { rich_text: [{ type: 'text', text: { content: 'someone-else' } }] },
  }, []);
  advance(backoffMs(1));
  await syncer.tick();
  const other = [...notion.pages.values()].find((p) => prop(p, 'syncId').rich_text[0].text.content === 'someone-else');
  assert.equal(other.in_trash, false);
  assert.equal(db.get(1).state, 'done');
});

test('an entry already saved in Notion (e.g. after a restore) is not sent again', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  await notion.createPage('ds-1', {
    [PROPERTIES.entryId.name]: { number: 5 },
    [PROPERTIES.status.name]: { select: { name: STATUS.full } },
  }, []);
  await notion.createPage('ds-1', {
    [PROPERTIES.entryId.name]: { number: 6 },
    [PROPERTIES.status.name]: { select: { name: STATUS.sending } },
  }, []);
  miniflux.add(5).add(6).star(5, 6);
  await syncer.tick();
  assert.equal(db.get(5).state, 'done');
  assert.equal(db.get(6).state, 'review');
  assert.equal(notion.pages.size, 2);
  assert.equal(notion.live().length, 2);
});

test('rate limiting pauses sending', async () => {
  const { db, miniflux, notion, syncer, advance } = await setup();
  miniflux.add(1).add(2).star(1, 2);
  notion.fail('query', () => notionErrors.rateLimited(120));
  await syncer.tick();
  assert.equal(notion.pages.size, 0);
  assert.equal(db.get(1).attempts, 0);
  const calls = notion.calls.length;
  advance(60_000);
  await syncer.tick();
  assert.equal(notion.calls.length, calls);
  advance(70_000);
  await syncer.tick();
  assert.equal(notion.live().length, 2);
});

test('authorization errors stop sending and are reported without counting attempts', async () => {
  const { db, miniflux, notion, syncer, advance } = await setup();
  miniflux.add(1).star(1);
  notion.fail('query', notionErrors.unauthorized);
  await syncer.tick();
  assert.equal(db.get(1).attempts, 0);
  assert.ok(db.getMeta('notion_error'));
  assert.equal(statusReport(db, CONFIG, new Date('2026-10-04T00:01:00Z')).ok, false);
  advance(CONFIG.pollMinutes * 60_000);
  await syncer.tick();
  assert.equal(db.get(1).state, 'done');
  assert.equal(db.getMeta('notion_error'), null);
});

test('the block limit is reported as such', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  miniflux.add(1).star(1);
  notion.fail('createPage', notionErrors.blockLimit);
  await syncer.tick();
  assert.match(db.getMeta('notion_error'), /free blocks/);
});

test('a database without the required properties is reported', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  delete notion.schema[PROPERTIES.syncId.name];
  miniflux.add(1).star(1);
  await syncer.tick();
  assert.equal(notion.pages.size, 0);
  assert.match(db.getMeta('notion_error'), /同期 ID.*setup-notion/);
});

test('entries deleted from Miniflux become missing', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  miniflux.star(99);
  await syncer.tick();
  assert.equal(db.get(99).state, 'missing');
  assert.equal(notion.pages.size, 0);
});

test('repeated failures end in failed, and other entries are still sent', async () => {
  const { db, miniflux, notion, syncer, advance } = await setup();
  miniflux.add(1).star(1);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    notion.fail('query', () => new Error('boom'));
    await syncer.tick();
    advance(backoffMs(i + 1));
  }
  assert.equal(db.get(1).state, 'failed');
  assert.equal(db.get(1).attempts, MAX_ATTEMPTS);
  const report = statusReport(db, CONFIG, new Date(db.getMeta('last_poll_ok_at')));
  assert.ok(report.problems.some((p) => p.includes('failed: 1')));
  miniflux.add(2).star(2);
  await syncer.tick();
  assert.equal(db.get(2).state, 'done');
});

test('short summaries are replaced with the full content when the feed does not crawl', async () => {
  const { miniflux, notion, syncer } = await setup();
  miniflux.add(1, { content: '<p>summary</p>' }).star(1);
  miniflux.fullContent.set(1, `<p>${'full '.repeat(200)}</p>`);
  miniflux.add(2, { content: '<p>summary</p>', feedCrawler: true }).star(2);
  miniflux.add(3, { content: '<p>summary</p>' }).star(3); // 取得に失敗する
  await syncer.tick();
  assert.deepEqual(miniflux.fetchContentCalls.sort(), [1, 3]);
  const text = (id) => notion.live().find((p) => prop(p, 'entryId').number === id).children[0].paragraph.rich_text[0].text.content;
  assert.match(text(1), /^full full/);
  assert.equal(text(2), 'summary');
  assert.equal(text(3), 'summary');
});

test('fetching full content can be disabled', async () => {
  const { miniflux, syncer } = await setup({ fetchFullContent: false });
  miniflux.add(1, { content: '<p>summary</p>' }).star(1);
  await syncer.tick();
  assert.deepEqual(miniflux.fetchContentCalls, []);
});

test('Miniflux errors are recorded and nothing is sent', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  miniflux.add(1).star(1);
  miniflux.failNext = new MinifluxError('miniflux GET /entries/ids failed: 401', { kind: 'fatal', status: 401 });
  await syncer.tick();
  assert.match(db.getMeta('miniflux_error'), /401.*STAR_MINIFLUX_API_KEY/);
  assert.equal(notion.pages.size, 0);
  await syncer.tick();
  assert.equal(db.getMeta('miniflux_error'), null);
  assert.equal(notion.live().length, 1);
});

test('statusReport flags stale polling and old unsent entries', async () => {
  const { db, miniflux, notion, syncer } = await setup();
  const t0 = new Date(db.getMeta('last_poll_ok_at'));
  assert.equal(statusReport(db, CONFIG, t0).ok, true);
  assert.equal(statusReport(db, CONFIG, new Date(t0.getTime() + 31 * 60_000)).ok, false);
  miniflux.add(1).star(1);
  notion.fail('query', () => new Error('boom'));
  await syncer.tick();
  const report = statusReport(db, CONFIG, new Date(t0.getTime() + 25 * 3600_000));
  assert.ok(report.problems.some((p) => p.includes('more than 24 hours')));
});
