// テスト用: ブロックが Notion API の上限・形式を満たしているか調べる
import assert from 'node:assert/strict';

const TEXT_TYPES = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'quote', 'code']);

function checkUrl(url, where) {
  assert.ok(url.length <= 2000, `${where}: url length`);
  assert.match(url, /^https?:\/\//, where);
}

function checkRichText(rich, where) {
  assert.ok(Array.isArray(rich), `${where}: rich_text must be an array`);
  assert.ok(rich.length <= 100, `${where}: ${rich.length} rich_text items`);
  for (const item of rich) {
    assert.equal(item.type, 'text', where);
    assert.equal(typeof item.text.content, 'string', where);
    assert.ok(item.text.content.length > 0, `${where}: empty text`);
    assert.ok(item.text.content.length <= 2000, `${where}: text ${item.text.content.length}`);
    if (item.text.link) checkUrl(item.text.link.url, where);
  }
}

/**
 * @param {any[]} blocks
 * @param {number} [depth]
 */
export function assertValidBlocks(blocks, depth = 0) {
  if (depth > 0) assert.ok(blocks.length <= 100, `children: ${blocks.length}`);
  for (const b of blocks) {
    const where = `${b.type}@${depth}`;
    assert.ok(b[b.type], `${where}: missing body`);
    if (TEXT_TYPES.has(b.type)) checkRichText(b[b.type].rich_text, where);
    if (b.type === 'code') assert.equal(b.code.language, 'plain text');
    if (b.type === 'image') {
      assert.equal(b.image.type, 'external');
      assert.match(b.image.external.url, /^https:\/\//, where);
      checkUrl(b.image.external.url, where);
      if (b.image.caption) checkRichText(b.image.caption, `${where} caption`);
    }
    if (b.type === 'bookmark') checkUrl(b.bookmark.url, where);
    const children = b[b.type].children;
    if (children) {
      assert.equal(depth, 0, `${where}: children are only allowed one level deep`);
      assertValidBlocks(children, depth + 1);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(b)) < 400_000, `${where}: block too large`);
  }
}
