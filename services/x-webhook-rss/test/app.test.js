import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
let server;
let baseUrl;
let db;

function config(overrides = {}) {
  return {
    webhookToken: TOKEN,
    allowedUsers: new Set(['example_user']),
    maxItems: 3,
    tzOffset: '+09:00',
    publicBaseUrl: 'http://x-webhook-rss:8080',
    ...overrides,
  };
}

async function start(cfg = config()) {
  db = openDb(':memory:');
  server = createServer(createApp({ db, config: cfg, now: () => new Date('2026-10-02T00:00:00Z') }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

function postForm(fields, token = TOKEN) {
  return fetch(`${baseUrl}/hook/x/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

const sample = (n, extra = {}) => ({
  username: 'Example_User',
  text: `post ${n} <b>&</b>`,
  link: `https://x.com/Example_User/status/${1000 + n}`,
  created_at: `October 02, 2026 at 0${n}:00PM`,
  ...extra,
});

beforeEach(() => start());
afterEach(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

test('トークンが違えば 404 で保存しない', async () => {
  const res = await postForm(sample(1), 'wrong-token');
  assert.equal(res.status, 404);
  const feed = await (await fetch(`${baseUrl}/feeds/x/example_user.xml`)).text();
  assert.doesNotMatch(feed, /<entry>/);
});

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
  const res = await fetch(`${baseUrl}/hook/x/${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample(2)),
  });
  assert.equal(res.status, 201);
});

test('同じリンクは重複保存しない', async () => {
  assert.equal((await postForm(sample(1))).status, 201);
  assert.equal((await postForm(sample(1))).status, 200);
  const xml = await (await fetch(`${baseUrl}/feeds/x/example_user.xml`)).text();
  assert.equal(xml.match(/<entry>/g).length, 1);
});

test('許可リスト外のアカウントは 403', async () => {
  const res = await postForm(sample(1, { username: 'someone_else', link: 'https://x.com/someone_else/status/1' }));
  assert.equal(res.status, 403);
});

test('不正なリンクは 400', async () => {
  const res = await postForm(sample(1, { link: 'https://evil.example/status/1' }));
  assert.equal(res.status, 400);
});

test('maxItems を超えた古い投稿は削除される', async () => {
  for (const n of [1, 2, 3, 4, 5]) await postForm(sample(n));
  const xml = await (await fetch(`${baseUrl}/feeds/x/example_user.xml`)).text();
  assert.equal(xml.match(/<entry>/g).length, 3);
  assert.match(xml, /status\/1005/);
  assert.doesNotMatch(xml, /status\/1001/);
});

test('healthz は最終受信時刻を返す', async () => {
  await postForm(sample(1));
  const body = await (await fetch(`${baseUrl}/healthz`)).json();
  assert.deepEqual(body, { ok: true, lastReceivedAt: '2026-10-02T00:00:00.000Z' });
});

test('大きすぎる本文は 413', async () => {
  const res = await postForm(sample(1, { text: 'a'.repeat(70 * 1024) }));
  assert.equal(res.status, 413);
});
