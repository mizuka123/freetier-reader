import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

function setup() {
  const clock = { now: new Date('2026-10-04T00:00:00Z') };
  const db = openDb(':memory:', () => clock.now);
  return { db, clock };
}

test('addNew never changes recorded entries', () => {
  const { db } = setup();
  db.initialize([1]);
  db.addNew([2, 3]);
  db.markDone(2, { pageId: 'p', mode: 'full', converterVersion: 1 });
  db.setState(3, 'ignored', null);
  assert.equal(db.addNew([1, 2, 3, 4]), 1);
  assert.deepEqual([1, 2, 3, 4].map((id) => db.get(id).state), ['baseline', 'done', 'ignored', 'pending']);
});

test('defer keeps the state that matches whether a send was started', () => {
  const { db, clock } = setup();
  db.addNew([1, 2]);
  const later = new Date(clock.now.getTime() + 60_000);
  db.defer(1, { error: 'e', nextAt: later, countAttempt: true });
  assert.equal(db.get(1).state, 'pending');
  assert.equal(db.get(1).attempts, 1);
  db.startSending(2, 'sync-a');
  db.setPageId(2, 'page-a');
  db.defer(2, { error: 'e', nextAt: later, countAttempt: false });
  assert.equal(db.get(2).state, 'sending');
  assert.equal(db.get(2).attempts, 0);
  // 待ち時間の間は送る対象にならない
  assert.deepEqual(db.due(10).map((r) => r.entry_id), []);
  clock.now = later;
  assert.deepEqual(db.due(10).map((r) => r.entry_id), [1, 2]);
  // 新しい送信では前回のページ ID を消す
  db.startSending(2, 'sync-b');
  assert.equal(db.get(2).page_id, null);
  assert.equal(db.get(2).sync_id, 'sync-b');
});

test('markDone clears the retry information', () => {
  const { db } = setup();
  db.addNew([1]);
  db.defer(1, { error: 'e', nextAt: new Date(), countAttempt: true });
  db.markDone(1, { pageId: 'p', mode: 'plain', converterVersion: 1 });
  const row = db.get(1);
  assert.equal(row.state, 'done');
  assert.equal(row.last_error, null);
  assert.equal(row.next_attempt_at, null);
  assert.ok(row.done_at);
});

test('reset keeps the sync id so the next attempt can clean up', () => {
  const { db } = setup();
  db.addNew([1, 2]);
  db.startSending(1, 'sync-a');
  db.setState(1, 'failed', 'boom');
  db.setState(2, 'review', 'check');
  db.reset(1);
  db.reset(2);
  assert.equal(db.get(1).state, 'sending');
  assert.equal(db.get(1).sync_id, 'sync-a');
  assert.equal(db.get(1).attempts, 0);
  assert.equal(db.get(2).state, 'pending');
});

test('backfill touches baseline entries only, newest first', () => {
  const { db } = setup();
  db.initialize([1, 2, 3]);
  db.addNew([4]);
  db.markDone(4, { pageId: 'p', mode: 'full', converterVersion: 1 });
  assert.equal(db.backfill(2), 2);
  assert.deepEqual([1, 2, 3, 4].map((id) => db.get(id).state), ['baseline', 'pending', 'pending', 'done']);
  assert.equal(db.backfill(Number.MAX_SAFE_INTEGER), 1);
  assert.equal(db.get(4).state, 'done');
});

test('resetFailed returns every failed entry to the queue', () => {
  const { db } = setup();
  db.addNew([1, 2, 3]);
  db.setState(1, 'failed', 'a');
  db.setState(2, 'failed', 'b');
  assert.equal(db.resetFailed(), 2);
  assert.equal(db.counts().pending, 3);
});
