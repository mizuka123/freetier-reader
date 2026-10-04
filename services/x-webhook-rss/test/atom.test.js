import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAtom } from '../src/atom.js';

const post = (text) => ({ link: 'https://x.com/a/status/1', text, created_at: '2026-10-02T00:00:00.000Z' });
const titleOf = (text) => /<entry>[\s\S]*?<title>(.*?)<\/title>/.exec(buildAtom({ username: 'a', selfUrl: 'http://h/feeds/x/a.xml', posts: [post(text)] }))[1];

test('タイトルは 1 行目のみ', () => {
  assert.equal(titleOf('first line\r\nsecond line'), 'first line');
});

test('80 文字を超えるタイトルは省略', () => {
  assert.equal(titleOf('a'.repeat(100)), `${'a'.repeat(80)}…`);
});

test('本文が空なら (no text)', () => {
  assert.equal(titleOf(''), '(no text)');
});

test('改行は <br> に変換してエスケープされる', () => {
  const xml = buildAtom({ username: 'a', selfUrl: 'http://h', posts: [post('x\ny')] });
  assert.match(xml, /x&lt;br&gt;y/);
});

test('image_url があれば本文に img を入れ、http(s) 以外は入れない', () => {
  const xml = (image_url) => buildAtom({ username: 'a', selfUrl: 'http://h', posts: [{ ...post('x'), image_url }] });
  assert.match(xml('https://img.example/a.jpg'), /&lt;img src=&quot;https:\/\/img\.example\/a\.jpg&quot;/);
  assert.doesNotMatch(xml('javascript:alert(1)'), /img src/);
  assert.doesNotMatch(xml(null), /img src/);
});
