import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, parseHtml, textContent } from '../src/html.js';

const tags = (node) => node.children.map((c) => (c.type === 'text' ? `#${c.text}` : c.tag));

test('entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &quot;e&quot; &nbsp;'), 'a & b <c> \'d\' "e"  ');
  assert.equal(decodeEntities('&unknown; &amp'), '&unknown; &');
  assert.equal(decodeEntities('&#0; &#xD800; &#x110000;'), '� � �');
  assert.equal(decodeEntities('&#128512;'), '😀');
  // 二重にデコードしない
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('nested elements, attributes and void tags', () => {
  const root = parseHtml('<p class=x title="a > b" data-x=\'1\'>Hi <b>there</b><br>you<img src="https://e.com/a.png" alt="A &amp; B"></p>');
  const p = root.children[0];
  assert.equal(p.tag, 'p');
  assert.equal(p.attrs.title, 'a > b');
  assert.equal(p.attrs['data-x'], '1');
  assert.deepEqual(tags(p), ['#Hi ', 'b', 'br', '#you', 'img']);
  assert.equal(p.children[4].attrs.alt, 'A & B');
});

test('broken html does not throw', () => {
  for (const html of ['<p>unclosed <b>bold', '</div>stray</span>', '<', 'a < b and c > d', '<!-- unclosed comment', '<p <b>', '<a href="unterminated>text', '<script>alert(1)</script>after', '<!DOCTYPE html><html><body>x</body></html>']) {
    assert.doesNotThrow(() => parseHtml(html), html);
  }
  assert.equal(textContent(parseHtml('a < b and c > d')), 'a < b and c > d');
  assert.equal(textContent(parseHtml('<script>alert(1)</script><style>p{}</style>after')), 'after');
  assert.equal(textContent(parseHtml('<!-- c -->x<!-- unclosed')), 'x');
});

test('implicitly closed p and li', () => {
  const root = parseHtml('<p>a<p>b<ul><li>1<li>2</ul>');
  assert.deepEqual(tags(root), ['p', 'p']);
  const ul = root.children[1].children[1];
  assert.equal(ul.tag, 'ul');
  assert.deepEqual(tags(ul), ['li', 'li']);
  // 入れ子のリストの li は外側の li を閉じない
  const nested = parseHtml('<ul><li>a<ul><li>b</li></ul></li></ul>').children[0];
  assert.equal(nested.children.length, 1);
});

test('deep nesting is capped instead of overflowing', () => {
  const html = '<div>'.repeat(10000) + 'deep' + '</div>'.repeat(10000);
  const root = parseHtml(html);
  assert.equal(textContent(root), 'deep');
  let depth = 0;
  for (let n = root; n.type === 'element' && n.children.length; n = n.children[0]) depth++;
  assert.ok(depth <= 70, `depth ${depth}`);
});

test('node count is capped', () => {
  const root = parseHtml('<b>x</b>'.repeat(100000));
  assert.ok(root.children.length <= 50000);
});
