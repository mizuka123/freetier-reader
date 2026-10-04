import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBlockedAddress, extractLinks, findImageInHtml, createLinkPreview, createPreviewWorker,
} from '../src/linkpreview.js';
import { openDb } from '../src/db.js';

test('isBlockedAddress: 内部・予約済みのアドレスを拒否し、公開アドレスは通す', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.18.0.2', '192.168.1.1', '100.64.0.1', '0.0.0.0',
    '::1', '::', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'fd12::1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '203.0.114.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, a);
  }
});

test('extractLinks: t.co の URL だけを重複なく取り出す', () => {
  assert.deepEqual(
    extractLinks('a https://t.co/AbC123 b https://example.com/x https://t.co/AbC123 https://t.co/zz9'),
    ['https://t.co/AbC123', 'https://t.co/zz9'],
  );
  assert.deepEqual(extractLinks('no links'), []);
});

test('findImageInHtml: og:image を優先し、相対 URL・実体参照・属性の順序に対応する', () => {
  assert.equal(
    findImageInHtml('<meta content="/img/a.jpg?x=1&amp;y=2" property="og:image">', 'https://news.example/p/1'),
    'https://news.example/img/a.jpg?x=1&y=2',
  );
  assert.equal(
    findImageInHtml("<meta name='twitter:image' content='https://cdn.example/t.png'><meta property=og:image content=https://cdn.example/o.png>", 'https://a.example/'),
    'https://cdn.example/o.png',
  );
  assert.equal(findImageInHtml('<meta name="twitter:image" content="https://cdn.example/t.png">', 'https://a.example/'), 'https://cdn.example/t.png');
  assert.equal(findImageInHtml('<meta property="og:image" content="javascript:alert(1)">', 'https://a.example/'), null);
  assert.equal(findImageInHtml('<meta property="og:title" content="x">', 'https://a.example/'), null);
});

// ---- ローカルの HTTP サーバでの取得（テストではアドレスの検査を外し、テスト用のポートを許可する） ----
let server;
let base;
const hits = [];
before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url);
    const page = (img) => `<html><head><meta property="og:image" content="${img}"></head><body>x</body></html>`;
    switch (req.url) {
      case '/page': res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page('/og.jpg'));
      case '/r1': res.writeHead(301, { location: '/r2' }); return res.end();
      case '/r2': res.writeHead(302, { location: `${base}/page` }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/json': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"og:image":"x"}');
      case '/to-x': res.writeHead(302, { location: 'https://x.com/user/status/1/photo/1' }); return res.end();
      case '/to-file': res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end();
      case '/big': {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write(page('https://cdn.example/big.jpg'));
        res.end('x'.repeat(200_000));
        return undefined;
      }
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function testPreview(extra = {}) {
  return createLinkPreview({ isBlocked: () => false, allowedPorts: [server.address().port], timeoutMs: 3000, ...extra });
}

test('imageForUrl: リダイレクトをたどって og:image を絶対 URL で返す', async () => {
  assert.equal(await testPreview().imageForUrl(`${base}/r1`), `${base}/og.jpg`);
});

test('imageForUrl: リダイレクト回数・HTML 以外・x.com・http(s) 以外では取りに行かない', async () => {
  const p = testPreview({ maxRedirects: 3 });
  assert.equal(await p.imageForUrl(`${base}/loop`), null);
  assert.equal(await p.imageForUrl(`${base}/json`), null);
  hits.length = 0;
  assert.equal(await p.imageForUrl(`${base}/to-x`), null);
  assert.deepEqual(hits, ['/to-x']); // x.com へは接続しない
  assert.equal(await p.imageForUrl(`${base}/to-file`), null);
  assert.equal(await p.imageForUrl('https://x.com/user/status/1'), null);
});

test('imageForUrl: 読み込みサイズの上限で打ち切っても head の og:image は取れる', async () => {
  assert.equal(await testPreview({ maxBytes: 1024 }).imageForUrl(`${base}/big`), 'https://cdn.example/big.jpg');
});

test('imageForUrl: 許可していないポートには接続しない', async () => {
  hits.length = 0;
  assert.equal(await createLinkPreview({ isBlocked: () => false }).imageForUrl(`${base}/page`), null);
  assert.deepEqual(hits, []);
});

test('imageForUrl: 既定の検査で、内部アドレス（IP 直指定・名前解決）への接続を拒否する', async () => {
  const port = server.address().port;
  const p = createLinkPreview({ allowedPorts: [port, 80] });
  hits.length = 0;
  await assert.rejects(p.imageForUrl(`http://127.0.0.1:${port}/page`), /non-public address 127\.0\.0\.1/);
  await assert.rejects(p.imageForUrl(`http://localhost:${port}/page`), /non-public address/);
  await assert.rejects(p.imageForUrl('http://169.254.169.254/latest/meta-data/'), /non-public address 169\.254\.169\.254/);
  assert.deepEqual(hits, []); // どれも接続していない
});

test('imageForUrl: 公開アドレスから内部アドレスへのリダイレクトも拒否する', async () => {
  // 最初の 1 回だけ公開扱いにし、リダイレクト先（127.0.0.1）は既定どおり検査する
  let first = true;
  const p = createLinkPreview({
    allowedPorts: [server.address().port],
    isBlocked: (a) => {
      if (first) {
        first = false;
        return false;
      }
      return isBlockedAddress(a);
    },
  });
  await assert.rejects(p.imageForUrl(`${base}/r2`), /non-public address/);
});

test('findImage: 失敗したリンクは飛ばしてエラーを通知し、例外を外に出さない', async () => {
  const errors = [];
  // すべてのアドレスを拒否する（外部には接続しない）
  const p = createLinkPreview({ isBlocked: () => true, timeoutMs: 3000 });
  const image = await p.findImage('see https://t.co/abc123', (link, err) => errors.push([link, err.message]));
  assert.equal(image, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'https://t.co/abc123');
});

test('createPreviewWorker: 未処理の投稿を順に処理し、失敗・見つからない場合も処理済みにする', async () => {
  const pending = [{ link: 'a', text: 'ta' }, { link: 'b', text: 'tb' }, { link: 'c', text: 'tc' }];
  const saved = {};
  const db = {
    pendingPreviews: (n) => pending.filter((p) => !(p.link in saved)).slice(0, n),
    setPreview: (link, url) => { saved[link] = url; },
  };
  const preview = {
    async findImage(text) {
      if (text === 'tb') throw new Error('boom');
      return text === 'ta' ? 'https://img.example/a.jpg' : null;
    },
  };
  const logs = [];
  const worker = createPreviewWorker({ db, preview, log: { warn: (m) => logs.push(m), error: (m) => logs.push(m) }, batchSize: 2 });
  await Promise.all([worker.kick(), worker.kick()]); // 二重に呼んでも 1 回ずつ処理する
  assert.deepEqual(saved, { a: 'https://img.example/a.jpg', b: null, c: null });
  assert.ok(logs.some((m) => String(m).includes('link preview error')));
});

test('openDb: 既存の DB に image_url / preview_checked の列を追加する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xw-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, link TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
      created_at TEXT NOT NULL, received_at TEXT NOT NULL);
      INSERT INTO posts (username, link, text, created_at, received_at)
      VALUES ('u', 'https://x.com/u/status/1', 'hi https://t.co/a', '2026-10-04T06:06:00.000Z', '2026-10-04T06:06:01.000Z');`);
    old.close();

    const db = openDb(path);
    assert.deepEqual(db.pendingPreviews(10).map((r) => ({ ...r })), [{ link: 'https://x.com/u/status/1', text: 'hi https://t.co/a' }]);
    db.setPreview('https://x.com/u/status/1', 'https://img.example/a.jpg');
    assert.deepEqual(db.pendingPreviews(10), []);
    assert.equal(db.listPosts('u', 10)[0].image_url, 'https://img.example/a.jpg');
    db.close();
    openDb(path).close(); // 2 回目の起動でも列を重複して追加しない
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
