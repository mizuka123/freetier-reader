import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openDb } from '../src/db.js';
import { schemaChanges } from '../src/page.js';
import { FULL_SCHEMA } from './fakes.js';

function withDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'star-to-notion-'));
    const path = join(dir, 'test.db');
    const out = { lines: [], log: (m) => out.lines.push(m), error: (m) => out.lines.push(`ERR ${m}`) };
    try {
      await fn({ path, env: { DB_PATH: path }, out });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('backfill moves the newest baseline entries to pending', withDb(async ({ path, env, out }) => {
  const db = openDb(path);
  db.initialize([1, 2, 3]);
  db.close();
  assert.equal(await main(['backfill', '2'], env, out), 0);
  const check = openDb(path);
  assert.equal(check.get(3).state, 'pending');
  assert.equal(check.get(2).state, 'pending');
  assert.equal(check.get(1).state, 'baseline');
  check.close();
  assert.equal(await main(['backfill', '--all'], env, out), 0);
  assert.equal(await main(['backfill', 'x'], env, out), 2);
}));

test('retry and ack', withDb(async ({ path, env, out }) => {
  const db = openDb(path);
  db.initialize([]);
  db.addNew([1, 2, 3]);
  db.setState(1, 'failed', 'boom');
  db.setState(2, 'review', 'check');
  db.markDone(3, { pageId: 'p', mode: 'full', converterVersion: 1 });
  db.close();

  assert.equal(await main(['status'], env, out), 1);
  assert.ok(out.lines.some((l) => /^1\tfailed/.test(l)));
  assert.equal(await main(['retry', '3'], env, out), 1);
  assert.equal(await main(['retry', '404'], env, out), 1);
  assert.equal(await main(['retry', '1'], env, out), 0);
  assert.equal(await main(['ack', '--all'], env, out), 0);

  const check = openDb(path);
  assert.equal(check.get(1).state, 'pending');
  assert.equal(check.get(1).attempts, 0);
  assert.equal(check.get(2).state, 'ignored');
  check.close();
}));

test('unknown commands print usage', withDb(async ({ env, out }) => {
  assert.equal(await main(['nope'], env, out), 2);
  assert.equal(await main([], env, out), 2);
  assert.match(out.lines.at(-1), /usage/);
}));

test('schemaChanges adds missing properties and renames the title', () => {
  const changes = schemaChanges({ Name: { type: 'title' } });
  assert.deepEqual(changes.Name, { name: 'タイトル' });
  assert.equal(changes['Miniflux ID'].type, 'number');
  assert.deepEqual(changes['状態'].select.options.map((o) => o.name), ['保存中', '保存済み', '簡易保存', '本文なし']);
  assert.deepEqual(schemaChanges(FULL_SCHEMA), {});
  assert.throws(() => schemaChanges({ ...FULL_SCHEMA, URL: { type: 'rich_text' } }), /"URL" must be url/);
});
