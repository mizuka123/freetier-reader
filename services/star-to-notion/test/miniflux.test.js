import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MinifluxError, createMiniflux } from '../src/miniflux.js';

const KEY = 'miniflux-api-key-for-tests';

function client(handler) {
  const calls = [];
  const miniflux = createMiniflux({
    baseUrl: 'http://miniflux:8080',
    apiKey: KEY,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(new URL(url), calls.length);
    },
  });
  return { miniflux, calls };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('starredIds follows offset pages until total is reached', async () => {
  const { miniflux, calls } = client((url) => {
    const offset = Number(url.searchParams.get('offset'));
    const ids = offset === 0 ? Array.from({ length: 10000 }, (_, i) => 20000 - i) : [5, 4, 4.5, 'x'];
    return json({ total: 10004, entry_ids: ids });
  });
  const ids = await miniflux.starredIds();
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('offset'), '10000');
  assert.equal(new URL(calls[0].url).searchParams.get('starred'), 'true');
  assert.equal(calls[0].init.headers['X-Auth-Token'], KEY);
  assert.equal(ids.length, 10002);
  assert.ok(ids.includes(4) && !ids.includes(4.5));
});

test('starredIds stops after a short page', async () => {
  const { miniflux, calls } = client(() => json({ total: 3, entry_ids: [3, 2, 1] }));
  assert.deepEqual(await miniflux.starredIds(), [3, 2, 1]);
  assert.equal(calls.length, 1);
});

test('errors are classified and never include the key or the response body', async () => {
  const cases = [[401, 'fatal'], [403, 'fatal'], [404, 'not_found'], [500, 'retryable']];
  for (const [status, kind] of cases) {
    const { miniflux } = client(() => new Response(`secret body ${KEY}`, { status }));
    await assert.rejects(miniflux.entry(42), (err) => {
      assert.ok(err instanceof MinifluxError);
      assert.equal(err.kind, kind);
      assert.match(err.message, /\/entries\/\{id\}/);
      assert.ok(!err.message.includes(KEY) && !err.message.includes('secret body'));
      return true;
    });
  }
  const { miniflux } = client(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(miniflux.starredIds(), (err) => err.kind === 'retryable');
});

test('entry keeps only the needed fields and tolerates missing ones', async () => {
  const { miniflux } = client(() => json({
    id: 7, title: 'T', url: 'https://e.com/7', content: '<p>x</p>', published_at: '2026-10-01T00:00:00Z',
    feed: { title: 'F', crawler: true, cookie: 'session=secret', password: 'pw' },
  }));
  const e = await miniflux.entry(7);
  assert.deepEqual(e, { id: 7, title: 'T', url: 'https://e.com/7', content: '<p>x</p>', publishedAt: '2026-10-01T00:00:00Z', feedTitle: 'F', feedCrawler: true });
  const empty = client(() => json({ feed: { crawler: 'yes' } }));
  const e2 = await empty.miniflux.entry(8);
  assert.equal(e2.title, '');
  assert.equal(e2.feedCrawler, false);
});

test('fetchContent does not ask Miniflux to update the entry', async () => {
  const { miniflux, calls } = client(() => json({ content: '<p>full</p>', reading_time: 1 }));
  assert.equal(await miniflux.fetchContent(9), '<p>full</p>');
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v1/entries/9/fetch-content');
  assert.equal(url.searchParams.has('update_content'), false);
});
