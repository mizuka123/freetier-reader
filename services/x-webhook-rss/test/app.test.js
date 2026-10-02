import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp, normalizeLink } from '../src/app.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
let server;
let baseUrl;
let db;
let clock;
let logs;

function config(overrides = {}) {
  return {
    webhookToken: TOKEN,
    allowedUsers: new Set(['example_user', 'other_user']),
    maxItems: 3,
    tzOffset: '+09:00',
    publicBaseUrl: 'http://x-webhook-rss:8080',
    staleHours: 0,
    ...overrides,
  };
}

async function start(cfg = config()) {
  clock = new Date('2026-10-02T00:00:00Z');
  db = openDb(':memory:', () => clock);
  logs = [];
  const log = { warn: (...a) => logs.push(['warn', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) };
  server = createServer(createApp({ db, config: cfg, now: () => clock, log }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  await new Promise((r) => server.close(r));
  db.close();
}

function postForm(fields, token = TOKEN) {
  return fetch(`${baseUrl}/hook/x/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

function postJson(body, token = TOKEN) {
  return fetch(`${baseUrl}/hook/x/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const feedXml = async (user = 'example_user') => (await fetch(`${baseUrl}/feeds/x/${user}.xml`)).text();
const healthy = async () => (await fetch(`${baseUrl}/healthz`)).status === 200;

const sample = (n, extra = {}) => ({
  username: 'Example_User',
  text: `post ${n} <b>&</b>`,
  link: `https://x.com/Example_User/status/${1000 + n}`,
  created_at: `October 02, 2026 at 0${n}:00PM`,
  ...extra,
});

beforeEach(() => start());
afterEach(() => stop());

// ---- 認証・入力検証 ----

test('トークンが違えば 404 で保存せず、トークンはログに出さない', async () => {
  const res = await postForm(sample(1), 'wrong-token-value');
  assert.equal(res.status, 404);
  assert.doesNotMatch(await feedXml(), /<entry>/);
  assert.ok(logs.some(([, m]) => m.includes('bad token')));
  assert.ok(logs.every(([, m]) => !m.includes('wrong-token-value')));
});

test('不正トークンの警告は 1 分に 1 回にまとめる', async () => {
  for (let i = 0; i < 5; i += 1) await postForm(sample(1), `bad-${i}`);
  assert.equal(logs.filter(([, m]) => m.includes('bad token')).length, 1);
  clock = new Date(clock.getTime() + 61_000);
  await postForm(sample(1), 'bad-again');
  assert.ok(logs.some(([, m]) => m.includes('bad token count=5')));
});

test('許可リストが空ならすべてのアカウントを受け付ける', async () => {
  await stop();
  await start(config({ allowedUsers: new Set() }));
  const res = await postForm(sample(1, { username: 'anyone', link: 'https://x.com/anyone/status/1' }));
  assert.equal(res.status, 201);
});

test('不正なパーセントエンコードでもプロセスは落ちず 400 を返す', async () => {
  assert.equal((await fetch(`${baseUrl}/feeds/x/%zz.xml`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/hook/x/%E0%A4%A`, { method: 'POST' })).status, 400);
  assert.ok(await healthy());
});

test('JSON の null / 数値 / 配列 / 文字列 / 壊れた JSON は 400', async () => {
  for (const body of ['null', '42', '[]', '"str"', '{not json']) {
    assert.equal((await postJson(body)).status, 400, body);
  }
  assert.ok(await healthy());
});

test('DB エラーでもプロセスは落ちず 500 を返してログに残す', async () => {
  db.close();
  const res = await postForm(sample(1));
  assert.equal(res.status, 500);
  assert.ok(logs.some(([level]) => level === 'error'));
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 500);
  db = openDb(':memory:'); // afterEach の close 用
});

test('GET の hook と POST の feed は 405', async () => {
  assert.equal((await fetch(`${baseUrl}/hook/x/${TOKEN}`)).status, 405);
  assert.equal((await fetch(`${baseUrl}/feeds/x/example_user.xml`, { method: 'POST' })).status, 405);
});

test('不正なユーザー名は 400、不正な名前のフィードは 404', async () => {
  for (const username of ['a'.repeat(16), 'a-b', '']) {
    assert.equal((await postForm(sample(1, { username }))).status, 400, username);
  }
  assert.equal((await fetch(`${baseUrl}/feeds/x/a-b.xml`)).status, 404);
});

test('許可リスト外のアカウントは 403 でログに残す', async () => {
  const res = await postForm(sample(1, { username: 'someone_else', link: 'https://x.com/someone_else/status/1' }));
  assert.equal(res.status, 403);
  assert.ok(logs.some(([, m]) => m.includes('username not allowed') && m.includes('someone_else')));
});

test('リンクは X の投稿 URL のみ受け付け、正規化して保存する', async () => {
  assert.equal(normalizeLink('https://twitter.com/Example_User/status/123?s=20'), 'https://x.com/Example_User/status/123');
  assert.equal(normalizeLink('https://mobile.x.com/a/status/1/'), 'https://x.com/a/status/1');
  for (const bad of [
    'https://evil.example/Example_User/status/1',
    'https://x.com.evil.example/a/status/1',
    'http://x.com/a/status/1',
    'https://x.com/a/status/1/photo/1',
    'https://x.com/a/status/1<script>',
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(normalizeLink(bad), null, bad);
  }
  assert.equal((await postForm(sample(1, { link: 'https://evil.example/status/1' }))).status, 400);
});

test('大きすぎる本文は 413', async () => {
  const res = await postForm(sample(1, { text: 'a'.repeat(70 * 1024) }));
  assert.equal(res.status, 413);
  assert.ok(await healthy());
});

// ---- 保存・フィード ----

test('form 形式で受信し、アカウント別 Atom に出る（XML エスケープ済み）', async () => {
  assert.equal((await postForm(sample(1))).status, 201);
  const res = await fetch(`${baseUrl}/feeds/x/example_user.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/atom\+xml/);
  const xml = await res.text();
  assert.match(xml, /<id>https:\/\/x\.com\/Example_User\/status\/1001<\/id>/);
  assert.match(xml, /<updated>2026-10-02T04:00:00\.000Z<\/updated>/);
  assert.match(xml, /post 1 &lt;b&gt;&amp;&lt;\/b&gt;/);
  assert.doesNotMatch(xml, /<b>/);
});

test('JSON 形式も受け付ける', async () => {
  assert.equal((await postJson(sample(2))).status, 201);
});

test('@ 付き・大文字小文字違いのユーザー名を同一アカウントとして扱う', async () => {
  assert.equal((await postForm(sample(1, { username: '@EXAMPLE_user' }))).status, 201);
  assert.match(await feedXml('EXAMPLE_USER'), /status\/1001/);
  assert.match(await feedXml('example_user'), /status\/1001/);
});

test('form の特殊文字（& = + % # 絵文字 改行）が欠落せず往復する', async () => {
  const text = 'a&b=c+d%e#f 😀\r\n2行目 <<<ではない>>>';
  assert.equal((await postForm(sample(1, { text }))).status, 201);
  const xml = await feedXml();
  assert.match(xml, /a&amp;amp;b=c\+d%e#f 😀&lt;br&gt;2行目/);
});

test('IFTTT の <<< >>> がそのまま届いた場合は外側の記号を除去する', async () => {
  const res = await postForm({
    username: '<<<Example_User>>>',
    text: '<<<hello>>>',
    link: '<<<https://x.com/Example_User/status/1001>>>',
    created_at: '<<<October 02, 2026 at 01:00PM>>>',
  });
  assert.equal(res.status, 201);
  const xml = await feedXml();
  assert.match(xml, /<title>hello<\/title>/);
  assert.match(xml, /<updated>2026-10-02T04:00:00\.000Z<\/updated>/);
});

test('created_at が解釈できなければ受信時刻を使い、警告ログを出す', async () => {
  assert.equal((await postForm(sample(1, { created_at: 'yesterday' }))).status, 201);
  assert.match(await feedXml(), /<updated>2026-10-02T00:00:00\.000Z<\/updated>/);
  assert.ok(logs.some(([, m]) => m.includes('created_at could not be parsed')));
});

test('同じリンクは重複保存しない', async () => {
  assert.equal((await postForm(sample(1))).status, 201);
  assert.equal(await (await postForm(sample(1))).text(), 'duplicate');
  assert.equal((await feedXml()).match(/<entry>/g).length, 1);
});

test('maxItems を超えた古い投稿は削除される', async () => {
  for (const n of [1, 2, 3, 4, 5]) await postForm(sample(n));
  const xml = await feedXml();
  assert.equal(xml.match(/<entry>/g).length, 3);
  assert.match(xml, /status\/1005/);
  assert.doesNotMatch(xml, /status\/1001/);
});

test('保持範囲より古い投稿は保存されず "pruned" を返す', async () => {
  for (const n of [3, 4, 5]) await postForm(sample(n));
  const res = await postForm(sample(1));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'pruned');
  assert.doesNotMatch(await feedXml(), /status\/1001/);
});

test('同時刻の投稿は後から届いたものを残す', async () => {
  for (const n of [1, 2, 3, 4]) await postForm(sample(n, { created_at: 'October 02, 2026 at 01:00PM' }));
  const xml = await feedXml();
  assert.match(xml, /status\/1004/);
  assert.doesNotMatch(xml, /status\/1001/);
});

test('削除はアカウントごと（他アカウントの投稿は消えない）', async () => {
  await postForm(sample(1, { username: 'other_user', link: 'https://x.com/other_user/status/1' }));
  for (const n of [2, 3, 4, 5]) await postForm(sample(n));
  assert.match(await feedXml('other_user'), /other_user\/status\/1</);
});

test('未知のアカウントは空の有効なフィードを返す', async () => {
  const xml = await feedXml('unknown_user');
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<updated>1970-01-01T00:00:00\.000Z<\/updated>/);
  assert.doesNotMatch(xml, /<entry>/);
});

test('HEAD はヘッダーのみ返す', async () => {
  await postForm(sample(1));
  const res = await fetch(`${baseUrl}/feeds/x/example_user.xml`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /atom/);
  assert.equal(await res.text(), '');
});

// ---- ヘルスチェック / 受信状況 ----

const statusOf = async () => {
  const res = await fetch(`${baseUrl}/status`);
  return { code: res.status, body: await res.json() };
};

test('healthz は受信状況に関係なく 200（コンテナのヘルスチェック用）', async () => {
  await stop();
  await start(config({ staleHours: 1 }));
  clock = new Date('2026-10-05T00:00:00Z');
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('status: 受信前は DB 作成時刻から数える', async () => {
  assert.deepEqual(await statusOf(), {
    code: 200,
    body: { ok: true, stale: false, lastWebhookAt: null, since: '2026-10-02T00:00:00.000Z' },
  });
});

test('status: 一度も受信しないまま staleHours を超えたら 503', async () => {
  await stop();
  await start(config({ staleHours: 24 }));
  clock = new Date('2026-10-03T00:00:01Z');
  const { code, body } = await statusOf();
  assert.equal(code, 503);
  assert.equal(body.stale, true);
  assert.equal(body.lastWebhookAt, null);
});

test('status: staleHours を超えて受信がなければ 503、受信すれば戻る', async () => {
  await stop();
  await start(config({ staleHours: 24 }));
  await postForm(sample(1));
  assert.equal((await statusOf()).body.lastWebhookAt, '2026-10-02T00:00:00.000Z');
  clock = new Date('2026-10-03T00:00:01Z');
  assert.equal((await statusOf()).code, 503);
  await postForm(sample(2));
  assert.equal((await statusOf()).code, 200);
});

test('status: 重複・保持範囲外の投稿でも受信時刻は更新される', async () => {
  await stop();
  await start(config({ staleHours: 24 }));
  for (const n of [3, 4, 5]) await postForm(sample(n));
  clock = new Date('2026-10-03T00:00:01Z');
  assert.equal(await (await postForm(sample(5))).text(), 'duplicate');
  assert.equal((await statusOf()).code, 200);
  clock = new Date('2026-10-04T00:00:02Z');
  assert.equal(await (await postForm(sample(1))).text(), 'pruned');
  assert.equal((await statusOf()).code, 200);
});

test('status: staleHours=0 なら判定しない', async () => {
  await stop();
  await start(config({ staleHours: 0 }));
  clock = new Date('2027-01-01T00:00:00Z');
  assert.equal((await statusOf()).code, 200);
});
