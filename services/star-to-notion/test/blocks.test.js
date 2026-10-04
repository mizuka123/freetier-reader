import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBlocks, contentLength, countBlocks, htmlToBlocks, safeUrl, toPlainBlocks, unwrapProxyUrl } from '../src/blocks.js';
import { assertValidBlocks } from './notion-limits.js';

const BASE = 'https://rss.example.com';
const convert = (html, maxBlocks = 1000) => {
  const result = htmlToBlocks(html, { publicBaseUrl: BASE, maxBlocks });
  assertValidBlocks(result.blocks);
  return result;
};
const blocks = (html) => convert(html).blocks;
const plain = (b) => b[b.type].rich_text.map((i) => i.text.content).join('');
const proxy = (url) => `${BASE}/proxy/c2lnbmF0dXJl/${Buffer.from(url).toString('base64url')}`;

test('paragraphs, inline styles and links', () => {
  const [p] = blocks('<p>  Hello <strong>bold <em>both</em></strong> &amp; <a href="https://e.com/?a=1&amp;b=2">link</a>  </p>');
  assert.equal(p.type, 'paragraph');
  assert.equal(plain(p), 'Hello bold both & link');
  const rich = p.paragraph.rich_text;
  assert.deepEqual(rich[1].annotations, { bold: true });
  assert.deepEqual(rich[2].annotations, { bold: true, italic: true });
  assert.equal(rich[4].text.link.url, 'https://e.com/?a=1&b=2');
});

test('br becomes a newline and whitespace is collapsed', () => {
  const [p] = blocks('<p>line one   \n  <br>  line two</p>');
  assert.equal(plain(p), 'line one\nline two');
});

test('unsafe links are dropped but text is kept', () => {
  const [p] = blocks('<p><a href="javascript:alert(1)">js</a> <a href="/relative">rel</a> <a href="https://user:pw@e.com/">cred</a></p>');
  assert.equal(plain(p), 'js rel cred');
  assert.ok(p.paragraph.rich_text.every((i) => !i.text.link));
});

test('headings', () => {
  const out = blocks('<h1>One</h1><h2>Two</h2><h3>Three</h3><h5>Five</h5><h2> </h2>');
  assert.deepEqual(out.map((b) => b.type), ['heading_1', 'heading_2', 'heading_3', 'heading_3']);
});

test('lists keep one level of nesting and flatten deeper levels', () => {
  const out = blocks('<ol><li>one<ul><li>a<ul><li>deep</li></ul></li></ul></li><li><p>two</p><p>more</p></li></ol>');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'numbered_list_item');
  assert.equal(plain(out[0]), 'one');
  assert.deepEqual(out[0].numbered_list_item.children.map(plain), ['a', 'deep']);
  assert.deepEqual(out[1].numbered_list_item.children.map(plain), ['more']);
});

test('more than 100 children are moved after the parent', () => {
  const items = Array.from({ length: 150 }, (_, i) => `<li>${i}</li>`).join('');
  const out = blocks(`<ul><li>parent<ul>${items}</ul></li></ul>`);
  assert.equal(out[0].bulleted_list_item.children.length, 100);
  assert.equal(out.length, 51);
});

test('quote, code and divider', () => {
  const out = blocks('<blockquote><p>quoted</p><p>second</p></blockquote><pre>\n  indented &lt;tag&gt;\n</pre><hr>');
  assert.equal(out[0].type, 'quote');
  assert.equal(plain(out[0]), 'quoted');
  assert.equal(out[0].quote.children.length, 1);
  assert.equal(out[1].type, 'code');
  assert.equal(plain(out[1]), '  indented <tag>');
  assert.equal(out[2].type, 'divider');
});

test('images: proxy URLs are unwrapped, http becomes a link, data URLs are dropped', () => {
  const out = blocks([
    `<figure><img src="${proxy('https://img.example.org/a.jpg')}"><figcaption>Caption <b>here</b></figcaption></figure>`,
    '<img src="http://insecure.example.org/b.png" alt="alt text">',
    '<img src="data:image/png;base64,AAAA">',
    `<img src="${proxy('javascript:alert(1)')}">`,
    '<img srcset="https://img.example.org/c.jpg 1x, https://img.example.org/c2.jpg 2x">',
  ].join(''));
  assert.equal(out[0].image.external.url, 'https://img.example.org/a.jpg');
  assert.equal(out[0].image.caption.map((i) => i.text.content).join(''), 'Caption here');
  assert.equal(out[1].type, 'paragraph');
  assert.equal(plain(out[1]), '画像: alt text');
  assert.equal(out[1].paragraph.rich_text[1].text.link.url, 'http://insecure.example.org/b.png');
  // 復号した結果が http(s) でない場合はプロキシの URL のまま使う
  assert.match(out[2].image.external.url, /^https:\/\/rss\.example\.com\/proxy\//);
  assert.equal(out[3].image.external.url, 'https://img.example.org/c.jpg');
  assert.equal(out.length, 4);
});

test('unwrapProxyUrl only touches URLs of the configured Miniflux', () => {
  const original = 'https://img.example.org/a.jpg?x=1';
  assert.equal(unwrapProxyUrl(proxy(original), BASE), original);
  const other = proxy(original).replace('rss.example.com', 'other.example.com');
  assert.equal(unwrapProxyUrl(other, BASE), other);
  assert.equal(unwrapProxyUrl(`${BASE}/proxy/onlyone`, BASE), `${BASE}/proxy/onlyone`);
  assert.equal(unwrapProxyUrl(`${proxy(original)}?q=1`, BASE), `${proxy(original)}?q=1`);
  // BASE_URL がサブパスの場合
  const sub = `https://rss.example.com/reader/proxy/c2ln/${Buffer.from(original).toString('base64url')}`;
  assert.equal(unwrapProxyUrl(sub, 'https://rss.example.com/reader'), original);
});

test('iframes become bookmarks (YouTube as a watch URL), video becomes a link', () => {
  const out = blocks('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0"></iframe><iframe src="https://player.example.com/1"></iframe><video src="https://v.example.com/a.mp4"></video>');
  assert.equal(out[0].bookmark.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(out[1].bookmark.url, 'https://player.example.com/1');
  assert.equal(plain(out[2]), '動画: https://v.example.com/a.mp4');
});

test('tables become one paragraph per row', () => {
  const out = blocks('<table><caption>Cap</caption><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td rowspan="2">2</td></tr><tr><td> </td><td></td></tr></tbody></table>');
  assert.deepEqual(out.map(plain), ['Cap', 'A | B', '1 | 2']);
  assert.deepEqual(out[1].paragraph.rich_text[0].annotations, { bold: true });
});

test('long text is split into 2000-character items without breaking surrogate pairs', () => {
  const text = '😀'.repeat(3000);
  const [p] = blocks(`<p>${text}</p>`);
  assert.equal(plain(p), text);
  for (const item of p.paragraph.rich_text) assert.ok(!/[\ud800-\udbff]$/.test(item.text.content));
});

test('paragraphs with too many rich_text items are split', () => {
  const html = `<p>${Array.from({ length: 250 }, (_, i) => `<b>${i}</b> `).join('')}</p>`;
  const out = blocks(html);
  assert.ok(out.length >= 3);
  assert.ok(out.every((b) => b.type === 'paragraph'));
});

test('maxBlocks truncates and reports it', () => {
  const html = Array.from({ length: 80 }, (_, i) => `<p>${i}</p>`).join('');
  const result = convert(html, 50);
  assert.equal(result.blocks.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(convert(html, 100).truncated, false);
});

test('empty and whitespace-only content produces no blocks', () => {
  assert.deepEqual(blocks(''), []);
  assert.deepEqual(blocks('<p> </p><div>\n</div><ul><li></li></ul><blockquote></blockquote>'), []);
});

test('toPlainBlocks keeps only text paragraphs', () => {
  const out = toPlainBlocks(blocks('<h1>T</h1><ul><li>a<ul><li>b</li></ul></li></ul><img src="https://e.com/a.png"><p><a href="https://e.com">x</a></p>'));
  assertValidBlocks(out);
  assert.deepEqual(out.map((b) => b.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph']);
  assert.deepEqual(out.map(plain), ['T', 'a', 'b', 'x']);
  assert.ok(out.every((b) => b.paragraph.rich_text.every((i) => !i.text.link && !i.annotations)));
});

test('chunkBlocks respects item, element and byte limits', () => {
  const divider = () => ({ type: 'divider', divider: {} });
  assert.deepEqual(chunkBlocks(Array.from({ length: 250 }, divider)).map((c) => c.length), [100, 100, 50]);
  const parent = { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [], children: Array.from({ length: 100 }, divider) } };
  const chunks = chunkBlocks(Array.from({ length: 20 }, () => parent));
  assert.ok(chunks.every((c) => countBlocks(c) <= 900));
  const big = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'あ'.repeat(2000) } }] } };
  const byBytes = chunkBlocks(Array.from({ length: 90 }, () => big));
  assert.ok(byBytes.length > 1);
  assert.ok(byBytes.every((c) => Buffer.byteLength(JSON.stringify(c)) <= 400_000));
});

test('contentLength ignores tags and whitespace', () => {
  assert.equal(contentLength('<p>a b</p>\n<p>c</p><img src="x">'), 3);
});

test('safeUrl', () => {
  assert.equal(safeUrl('https://e.com/a b'), 'https://e.com/a%20b');
  assert.equal(safeUrl('mailto:a@e.com'), null);
  assert.equal(safeUrl(`https://e.com/${'a'.repeat(2000)}`), null);
  assert.equal(safeUrl(undefined), null);
});

test('fuzz: random HTML always produces valid blocks', () => {
  const pieces = ['<p>', '</p>', '<b>', '</b>', '<i>', '<a href="https://e.com/x">', '</a>', '<ul>', '<ol>', '<li>', '</li>', '</ul>', '</ol>',
    '<blockquote>', '</blockquote>', '<h2>', '</h2>', '<pre>', '</pre>', '<br>', '<hr>', '<img src="https://e.com/i.png">',
    '<figure>', '<figcaption>', '</figure>', '<table>', '<tr>', '<td>', '</table>', '<code>', '&amp;', '&lt;', '&#x1F600;', ' ', '\n',
    'text', 'テキスト', '<', '>', '"', '<!--', '-->', '<iframe src="https://www.youtube.com/embed/abcdefg">', '</iframe>', 'x'.repeat(2500)];
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    let html = '';
    const len = 1 + rand(80);
    for (let i = 0; i < len; i++) html += pieces[rand(pieces.length)];
    const result = htmlToBlocks(html, { publicBaseUrl: BASE, maxBlocks: 1000 });
    assertValidBlocks(result.blocks);
    assertValidBlocks(toPlainBlocks(result.blocks));
    for (const chunk of chunkBlocks(result.blocks)) assert.ok(chunk.length <= 100);
  }
});
