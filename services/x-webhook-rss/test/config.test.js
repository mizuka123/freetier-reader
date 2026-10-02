import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const TOKEN = 'x'.repeat(48);
const base = (extra = {}) => ({ X_WEBHOOK_TOKEN: TOKEN, ...extra });

test('既定値', () => {
  const c = loadConfig(base());
  assert.equal(c.port, 8080);
  assert.equal(c.maxItems, 200);
  assert.equal(c.tzOffset, '+09:00');
  assert.equal(c.staleHours, 0);
  assert.equal(c.allowedUsers.size, 0);
  assert.equal(c.publicBaseUrl, 'http://x-webhook-rss:8080');
});

test('トークンが短い・CHANGE_ME なら起動しない', () => {
  assert.throws(() => loadConfig({}), /X_WEBHOOK_TOKEN/);
  assert.throws(() => loadConfig({ X_WEBHOOK_TOKEN: 'short' }), /X_WEBHOOK_TOKEN/);
  assert.throws(() => loadConfig({ X_WEBHOOK_TOKEN: 'CHANGE_ME' }), /X_WEBHOOK_TOKEN/);
});

test('タイムゾーンは範囲も検証する', () => {
  assert.equal(loadConfig(base({ X_IFTTT_TZ_OFFSET: '-05:30' })).tzOffset, '-05:30');
  for (const v of ['+9:00', '+99:99', '+15:00', '09:00', '+09:60']) {
    assert.throws(() => loadConfig(base({ X_IFTTT_TZ_OFFSET: v })), /X_IFTTT_TZ_OFFSET/, v);
  }
});

test('許可ユーザーは @ と空白を除き小文字化、空要素は無視', () => {
  const c = loadConfig(base({ X_ALLOWED_USERS: ' @Foo, bar ,,' }));
  assert.deepEqual([...c.allowedUsers], ['foo', 'bar']);
  assert.throws(() => loadConfig(base({ X_ALLOWED_USERS: 'ok,not-valid' })), /X_ALLOWED_USERS/);
});

test('数値は整数かつ範囲内のみ', () => {
  assert.equal(loadConfig(base({ X_MAX_ITEMS: '50', PORT: '9000', X_STALE_HOURS: '48' })).maxItems, 50);
  for (const [name, v] of [['X_MAX_ITEMS', 'abc'], ['X_MAX_ITEMS', '0'], ['X_MAX_ITEMS', '-1'], ['X_MAX_ITEMS', '1.5'],
    ['PORT', '0'], ['PORT', '70000'], ['PORT', 'http'], ['X_STALE_HOURS', '-1']]) {
    assert.throws(() => loadConfig(base({ [name]: v })), new RegExp(name), `${name}=${v}`);
  }
});

test('X_FEED_BASE_URL の末尾スラッシュを除去', () => {
  assert.equal(loadConfig(base({ X_FEED_BASE_URL: 'http://h:1/' })).publicBaseUrl, 'http://h:1');
});
