import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseNotionId } from '../src/config.js';

const ID = '0123456789abcdef0123456789abcdef';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';
const base = {
  NOTION_TOKEN: 'dummy-notion-token',
  NOTION_DATABASE_ID: ID,
  STAR_MINIFLUX_API_KEY: 'miniflux-test-key',
  MINIFLUX_PUBLIC_URL: 'https://rss.example.com/',
};

test('defaults', () => {
  const c = loadConfig(base);
  assert.equal(c.notionDatabaseId, UUID);
  assert.equal(c.minifluxUrl, 'http://miniflux:8080');
  assert.equal(c.minifluxPublicUrl, 'https://rss.example.com');
  assert.equal(c.pollMinutes, 5);
  assert.equal(c.fetchFullContent, true);
  assert.equal(c.minContentChars, 500);
  assert.equal(c.maxBlocks, 1000);
  assert.equal(c.dbPath, '/data/star-to-notion.db');
});

test('secrets are required and never echoed', () => {
  for (const name of ['NOTION_TOKEN', 'STAR_MINIFLUX_API_KEY']) {
    for (const value of [undefined, '', 'CHANGE_ME']) {
      assert.throws(() => loadConfig({ ...base, [name]: value }), new RegExp(`${name} is not set`));
    }
  }
  assert.throws(() => loadConfig({ ...base, NOTION_TOKEN: 'secret value' }), (err) => {
    assert.match(err.message, /must not contain whitespace/);
    assert.doesNotMatch(err.message, /secret value/);
    return true;
  });
});

test('database id formats', () => {
  assert.equal(parseNotionId(ID), UUID);
  assert.equal(parseNotionId(UUID), UUID);
  assert.equal(parseNotionId(ID.toUpperCase()), UUID);
  assert.equal(parseNotionId(`https://www.notion.so/workspace/Starred-${ID}?v=fedcba9876543210fedcba9876543210`), UUID);
  assert.equal(parseNotionId(`https://app.notion.com/p/${ID}`), UUID);
  assert.equal(parseNotionId('not-an-id'), null);
  assert.equal(parseNotionId(`${ID}0`), null);
  assert.equal(parseNotionId(''), null);
  assert.throws(() => loadConfig({ ...base, NOTION_DATABASE_ID: 'nope' }), /NOTION_DATABASE_ID/);
});

test('ranges and booleans', () => {
  assert.equal(loadConfig({ ...base, STAR_POLL_MINUTES: '1' }).pollMinutes, 1);
  assert.throws(() => loadConfig({ ...base, STAR_POLL_MINUTES: '0' }), /STAR_POLL_MINUTES/);
  assert.throws(() => loadConfig({ ...base, STAR_POLL_MINUTES: '2.5' }), /STAR_POLL_MINUTES/);
  assert.equal(loadConfig({ ...base, STAR_FETCH_FULL_CONTENT: 'false' }).fetchFullContent, false);
  assert.throws(() => loadConfig({ ...base, STAR_FETCH_FULL_CONTENT: 'yes' }), /STAR_FETCH_FULL_CONTENT/);
  assert.throws(() => loadConfig({ ...base, STAR_MAX_BLOCKS: '10' }), /STAR_MAX_BLOCKS/);
  assert.throws(() => loadConfig({ ...base, MINIFLUX_URL: 'ftp://miniflux' }), /MINIFLUX_URL/);
  assert.throws(() => loadConfig({ ...base, MINIFLUX_PUBLIC_URL: 'not a url' }), /MINIFLUX_PUBLIC_URL/);
});
