// 記事本文の HTML を Notion のブロックに変換する。
// Notion API の上限（rich_text 1 要素 2000 文字・1 配列 100 要素、URL 2000 文字、1 リクエストの入れ子は 2 階層まで）を
// 変換の時点で守る。対応しない要素は文字として残し、変換できない画像や埋め込みはリンクにする。
import { parseHtml, textContent } from './html.js';

/** 変換の仕様を変えたら上げる（どの版で保存したかを記録する） */
export const CONVERTER_VERSION = 1;

const TEXT_LIMIT = 2000;
const RICH_TEXT_ITEMS = 100;
const URL_LIMIT = 2000;
const CHILDREN_LIMIT = 100;
// 1 ブロックの文字数の上限。1 リクエスト 500KB の上限に対し、1 ブロックが大きくなりすぎないようにする
const BLOCK_CHARS = 60000;
// この長さを超える HTML は切り詰める（VM のメモリを守る）
export const MAX_HTML_CHARS = 2_000_000;

/**
 * @typedef {{ bold?: boolean, italic?: boolean, strikethrough?: boolean, underline?: boolean, code?: boolean }} Style
 * @typedef {{ text: string, style: Style, link: string | null }} Run
 * @typedef {Record<string, any>} Block  Notion のブロック（type と同名のキーを持つ）
 * @typedef {import('./html.js').Node} Node
 * @typedef {import('./html.js').ElementNode} ElementNode
 */

const HEADINGS = { h1: 'heading_1', h2: 'heading_2', h3: 'heading_3', h4: 'heading_3', h5: 'heading_3', h6: 'heading_3' };
const INLINE_STYLES = {
  b: { bold: true }, strong: { bold: true },
  i: { italic: true }, em: { italic: true }, cite: { italic: true }, dfn: { italic: true }, var: { italic: true },
  s: { strikethrough: true }, del: { strikethrough: true }, strike: { strikethrough: true },
  u: { underline: true }, ins: { underline: true },
  code: { code: true }, kbd: { code: true }, samp: { code: true }, tt: { code: true },
};
// 中の文字を段落として区切る要素（それ以外の未知の要素は、文字の装飾として中身だけを使う）
const BLOCK_CONTAINERS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'address', 'center',
  'details', 'summary', 'dl', 'dd', 'caption', 'form', 'fieldset', 'body', 'html', 'picture', 'tbody', 'thead', 'tfoot',
]);

/**
 * http(s) の URL として正しく、Notion が受け付ける長さなら正規化した URL を返す。
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function safeUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href.length <= URL_LIMIT ? url.href : null;
}

/**
 * Miniflux のメディアプロキシの URL（<BASE_URL>/proxy/<署名>/<base64url の元 URL>）を元の URL に戻す。
 * BASE_URL と形式が一致しない URL はそのまま返す。
 * @param {string} raw
 * @param {string} publicBaseUrl  Miniflux の BASE_URL
 * @returns {string}
 */
export function unwrapProxyUrl(raw, publicBaseUrl) {
  let url;
  let base;
  try {
    url = new URL(raw);
    base = new URL(publicBaseUrl);
  } catch {
    return raw;
  }
  if (url.origin !== base.origin || url.search || url.hash) return raw;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (!url.pathname.startsWith(`${basePath}/proxy/`)) return raw;
  const m = /^\/proxy\/([A-Za-z0-9_-]+={0,2})\/([A-Za-z0-9_-]+={0,2})$/.exec(url.pathname.slice(basePath.length));
  if (!m) return raw;
  const decoded = Buffer.from(m[2], 'base64url').toString('utf8');
  // 復号した結果が URL として正しい場合だけ採用する
  return safeUrl(decoded) ?? raw;
}

const collapse = (s) => s.replace(/[ \t\n\r\f]+/g, ' ');

/** サロゲートペアを分断しない位置で文字列を分ける */
function splitText(text, size) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const sameStyle = (a, b) => ['bold', 'italic', 'strikethrough', 'underline', 'code'].every((k) => !!a[k] === !!b[k]);

/**
 * 文字の並び（Run）を Notion の rich_text の要素に変換する。2000 文字を超える要素は分ける。
 * @param {Run[]} runs
 */
function toRichText(runs) {
  const merged = [];
  for (const r of runs) {
    if (r.text === '') continue;
    const last = merged[merged.length - 1];
    if (last && last.link === r.link && sameStyle(last.style, r.style)) {
      last.text += r.text;
    } else {
      merged.push({ ...r });
    }
  }
  const items = [];
  for (const r of merged) {
    for (const part of splitText(r.text, TEXT_LIMIT)) {
      /** @type {Record<string, any>} */
      const item = { type: 'text', text: { content: part } };
      if (r.link) item.text.link = { url: r.link };
      const ann = Object.fromEntries(Object.entries(r.style).filter(([, v]) => v));
      if (Object.keys(ann).length) item.annotations = ann;
      items.push(item);
    }
  }
  return items;
}

/**
 * 段落の文字の並びの空白を整える（連続する空白を 1 つに、改行の前後と両端の空白を除く）。
 * @param {Run[]} runs
 */
function normalizeRuns(runs) {
  const out = [];
  let prevEndsWithSpace = true; // 先頭の空白を除くため
  for (const r of runs) {
    if (r.text === '\n') {
      const last = out[out.length - 1];
      if (last) last.text = last.text.replace(/ +$/, '');
      out.push({ ...r });
      prevEndsWithSpace = true;
      continue;
    }
    let text = collapse(r.text);
    if (prevEndsWithSpace) text = text.replace(/^ +/, '');
    if (text === '') continue;
    out.push({ ...r, text });
    prevEndsWithSpace = text.endsWith(' ');
  }
  // 末尾の空白と改行を除く
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/[ \n]+$/, '');
    if (last.text !== '') break;
    out.pop();
  }
  return out;
}

/**
 * rich_text の要素を、上限（100 要素・BLOCK_CHARS 文字）に収まるように分ける。
 * @param {Record<string, any>[]} items
 */
function chunkRichText(items) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const len = item.text.content.length;
    if (current.length && (current.length >= RICH_TEXT_ITEMS || chars + len > BLOCK_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * 文字を持つブロックを作る。上限を超える場合は複数のブロックに分ける（見出しの続きは段落にする）。
 * @param {string} type
 * @param {Record<string, any>[]} items
 * @returns {Block[]}
 */
function textBlocks(type, items) {
  return chunkRichText(items).map((chunk, i) => {
    const t = i > 0 && type.startsWith('heading_') ? 'paragraph' : type;
    return { type: t, [t]: { rich_text: chunk } };
  });
}

/**
 * 入れ子のブロックを平らにする（子を持てない深さで使う）。
 * @param {Block[]} blocks
 * @returns {Block[]}
 */
function flatten(blocks) {
  const out = [];
  for (const b of blocks) {
    const children = b[b.type]?.children;
    if (children) {
      const { children: _, ...rest } = b[b.type];
      out.push({ ...b, [b.type]: rest }, ...flatten(children));
    } else {
      out.push(b);
    }
  }
  return out;
}

function linkParagraph(prefix, label, url) {
  return [{
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: prefix } },
        ...splitText(label, TEXT_LIMIT).slice(0, RICH_TEXT_ITEMS - 1)
          .map((part) => ({ type: 'text', text: { content: part, link: { url } } })),
      ],
    },
  }];
}

class Converter {
  /**
   * @param {{ publicBaseUrl: string }} options
   */
  constructor(options) {
    this.publicBaseUrl = options.publicBaseUrl;
  }

  /**
   * 子ノードの並びをブロックの列に変換する。
   * @param {Node[]} nodes
   * @param {number} depth  0 = ページの直下。1 以上では子を持つブロックを作らない
   * @returns {Block[]}
   */
  convert(nodes, depth) {
    /** @type {Block[]} */
    const blocks = [];
    /** @type {Run[]} */
    let runs = [];
    const flush = () => {
      const items = toRichText(normalizeRuns(runs));
      runs = [];
      if (items.length) blocks.push(...textBlocks('paragraph', items));
    };
    /** @param {Block[]} produced */
    const emit = (produced) => {
      flush();
      blocks.push(...produced);
    };

    /**
     * @param {Node} node
     * @param {Style} style
     * @param {string | null} link
     */
    const walk = (node, style, link) => {
      if (node.type === 'text') {
        runs.push({ text: node.text, style, link });
        return;
      }
      const tag = node.tag;
      if (tag === 'br') {
        runs.push({ text: '\n', style: {}, link: null });
        return;
      }
      if (tag === 'wbr' || tag === 'rp' || tag === 'source' || tag === 'track') return;
      if (tag in INLINE_STYLES) {
        for (const c of node.children) walk(c, { ...style, ...INLINE_STYLES[tag] }, link);
        return;
      }
      if (tag === 'a') {
        const href = safeUrl(node.attrs.href);
        for (const c of node.children) walk(c, style, href ?? link);
        return;
      }
      if (tag === 'q') {
        runs.push({ text: '“', style, link });
        for (const c of node.children) walk(c, style, link);
        runs.push({ text: '”', style, link });
        return;
      }

      // ここから先はブロックになる要素。それまでの文字を段落として確定する
      if (tag in HEADINGS) {
        const items = toRichText(normalizeRuns(this.inlineRuns(node.children, {})));
        emit(items.length ? textBlocks(HEADINGS[tag], items) : []);
      } else if (tag === 'ul' || tag === 'ol') {
        emit(this.list(node, depth));
      } else if (tag === 'li') {
        // ul / ol の外にある li は箇条書きとして扱う
        emit(this.container('bulleted_list_item', node.children, depth));
      } else if (tag === 'blockquote') {
        emit(this.container('quote', node.children, depth));
      } else if (tag === 'pre') {
        emit(this.code(node));
      } else if (tag === 'hr') {
        emit([{ type: 'divider', divider: {} }]);
      } else if (tag === 'img') {
        emit(this.image(node));
      } else if (tag === 'figure') {
        emit(this.figure(node, depth));
      } else if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
        emit(this.embed(node));
      } else if (tag === 'video' || tag === 'audio') {
        emit(this.media(node));
      } else if (tag === 'table') {
        emit(this.table(node));
      } else if (tag === 'dt') {
        flush();
        for (const c of node.children) walk(c, { ...style, bold: true }, link);
        flush();
      } else if (BLOCK_CONTAINERS.has(tag)) {
        flush();
        for (const c of node.children) walk(c, style, link);
        flush();
      } else {
        // 未知の要素（span、small、sub、time など）は中身だけを使う
        for (const c of node.children) walk(c, style, link);
      }
    };

    for (const n of nodes) walk(n, {}, null);
    flush();
    return blocks;
  }

  /**
   * 見出しなど、文字だけを取り出す要素の中身を Run の列にする（中のブロック要素は区切らずに続ける）。
   * @param {Node[]} nodes
   * @param {Style} style
   * @param {string | null} [link]
   * @returns {Run[]}
   */
  inlineRuns(nodes, style, link = null) {
    const runs = [];
    for (const n of nodes) {
      if (n.type === 'text') {
        runs.push({ text: n.text, style, link });
      } else if (n.tag === 'br') {
        runs.push({ text: '\n', style: {}, link: null });
      } else if (n.tag === 'a') {
        runs.push(...this.inlineRuns(n.children, style, safeUrl(n.attrs.href) ?? link));
      } else if (n.tag !== 'img') {
        runs.push(...this.inlineRuns(n.children, { ...style, ...(INLINE_STYLES[n.tag] ?? {}) }, link));
      }
    }
    return runs;
  }

  /**
   * li や blockquote のように、最初の段落を自分の文字にし、残りを子にするブロックを作る。
   * @param {string} type
   * @param {Node[]} nodes
   * @param {number} depth
   * @returns {Block[]}
   */
  container(type, nodes, depth) {
    const inner = this.convert(nodes, depth + 1);
    let richText = [];
    let rest = inner;
    if (inner[0]?.type === 'paragraph') {
      richText = inner[0].paragraph.rich_text;
      rest = inner.slice(1);
    }
    if (richText.length === 0 && rest.length === 0) return [];
    /** @type {Block} */
    const block = { type, [type]: { rich_text: richText } };
    rest = flatten(rest);
    if (depth > 0 || rest.length === 0) return [block, ...rest];
    // 子は 1 階層まで・100 個まで。超えた分は後ろに並べる
    block[type].children = rest.slice(0, CHILDREN_LIMIT);
    return [block, ...rest.slice(CHILDREN_LIMIT)];
  }

  /**
   * @param {ElementNode} node  ul / ol
   * @param {number} depth
   * @returns {Block[]}
   */
  list(node, depth) {
    const type = node.tag === 'ol' ? 'numbered_list_item' : 'bulleted_list_item';
    const out = [];
    for (const child of node.children) {
      if (child.type === 'element' && child.tag === 'li') {
        out.push(...this.container(type, child.children, depth));
      } else if (child.type === 'element' || child.text.trim() !== '') {
        out.push(...this.convert([child], depth));
      }
    }
    return out;
  }

  /** @param {ElementNode} node  pre */
  code(node) {
    const text = textContent(node).replace(/^\n/, '').replace(/\s+$/, '');
    if (text === '') return [];
    const items = splitText(text, TEXT_LIMIT).map((part) => ({ type: 'text', text: { content: part } }));
    return chunkRichText(items).map((chunk) => ({ type: 'code', code: { rich_text: chunk, language: 'plain text' } }));
  }

  /**
   * 画像の URL を決める。Miniflux のプロキシ URL は元に戻す。
   * @param {ElementNode} node
   */
  imageUrl(node) {
    let src = node.attrs.src;
    if (!src && node.attrs.srcset) src = node.attrs.srcset.trim().split(/\s+/)[0];
    const url = safeUrl(src);
    return url ? safeUrl(unwrapProxyUrl(url, this.publicBaseUrl)) : null;
  }

  /**
   * @param {ElementNode} node  img
   * @returns {Block[]}
   */
  image(node) {
    const url = this.imageUrl(node);
    if (!url) return [];
    if (url.startsWith('https:')) {
      return [{ type: 'image', image: { type: 'external', external: { url } } }];
    }
    // Notion は http の画像を受け付けないため、リンクにする
    const label = collapse(node.attrs.alt ?? '').trim() || url;
    return linkParagraph('画像: ', label, url);
  }

  /**
   * @param {ElementNode} node  figure
   * @param {number} depth
   * @returns {Block[]}
   */
  figure(node, depth) {
    const captionNode = node.children.find((c) => c.type === 'element' && c.tag === 'figcaption');
    const body = node.children.filter((c) => c !== captionNode);
    const blocks = this.convert(body, depth);
    if (captionNode?.type !== 'element') return blocks;
    const caption = toRichText(normalizeRuns(this.inlineRuns(captionNode.children, {})));
    if (caption.length === 0) return blocks;
    const last = blocks[blocks.length - 1];
    if (last?.type === 'image' && chunkRichText(caption).length === 1) {
      last.image.caption = caption;
      return blocks;
    }
    const italic = caption.map((i) => ({ ...i, annotations: { ...i.annotations, italic: true } }));
    return [...blocks, ...textBlocks('paragraph', italic)];
  }

  /** @param {ElementNode} node  iframe など */
  embed(node) {
    const url = safeUrl(node.attrs.src ?? node.attrs.data);
    if (!url) return [];
    const youtube = /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,20})/.exec(url);
    if (youtube) return [{ type: 'bookmark', bookmark: { url: `https://www.youtube.com/watch?v=${youtube[1]}` } }];
    return [{ type: 'bookmark', bookmark: { url } }];
  }

  /** @param {ElementNode} node  video / audio */
  media(node) {
    const source = node.children.find((c) => c.type === 'element' && c.tag === 'source' && c.attrs.src);
    const url = safeUrl(node.attrs.src ?? (source?.type === 'element' ? source.attrs.src : undefined));
    if (!url) return [];
    const original = safeUrl(unwrapProxyUrl(url, this.publicBaseUrl)) ?? url;
    return linkParagraph(node.tag === 'video' ? '動画: ' : '音声: ', original, original);
  }

  /**
   * 表は行ごとの段落にする（セルを「 | 」で区切る。見出しのセルだけの行は太字）。
   * @param {ElementNode} node
   * @returns {Block[]}
   */
  table(node) {
    const blocks = [];
    const rows = [];
    const collect = (n) => {
      for (const c of n.children) {
        if (c.type !== 'element') continue;
        if (c.tag === 'tr') rows.push(c);
        else if (c.tag === 'caption') blocks.push(...this.convert(c.children, 1));
        else if (c.tag !== 'table') collect(c);
      }
    };
    collect(node);
    for (const row of rows) {
      const cells = row.children.filter((c) => c.type === 'element' && (c.tag === 'td' || c.tag === 'th'));
      const texts = cells.map((c) => collapse(textContent(c)).trim());
      if (texts.every((t) => t === '')) continue;
      const header = cells.every((c) => c.type === 'element' && c.tag === 'th');
      const items = toRichText([{ text: texts.join(' | '), style: header ? { bold: true } : {}, link: null }]);
      blocks.push(...textBlocks('paragraph', items));
    }
    return blocks;
  }
}

/**
 * ブロックの数（入れ子の子も数える）
 * @param {Block[]} blocks
 */
export function countBlocks(blocks) {
  let n = 0;
  for (const b of blocks) n += 1 + (b[b.type]?.children?.length ?? 0);
  return n;
}

/**
 * 記事本文の HTML を Notion のブロックに変換する。
 * @param {string} html
 * @param {{ publicBaseUrl: string, maxBlocks: number }} options
 * @returns {{ blocks: Block[], truncated: boolean }}  truncated: 上限で後ろを省略したか
 */
export function htmlToBlocks(html, options) {
  let source = String(html ?? '');
  let truncated = false;
  if (source.length > MAX_HTML_CHARS) {
    source = source.slice(0, MAX_HTML_CHARS);
    truncated = true;
  }
  const tree = parseHtml(source);
  const all = new Converter(options).convert(tree.children, 0);
  const blocks = [];
  let count = 0;
  for (const b of all) {
    const n = countBlocks([b]);
    if (count + n > options.maxBlocks) {
      truncated = true;
      break;
    }
    blocks.push(b);
    count += n;
  }
  return { blocks, truncated };
}

/**
 * 変換したブロックを、装飾・リンク・画像のない段落だけにする（Notion が本文を受け付けなかったときの代わり）。
 * @param {Block[]} blocks
 * @returns {Block[]}
 */
export function toPlainBlocks(blocks) {
  const out = [];
  for (const b of flatten(blocks)) {
    const rich = b[b.type]?.rich_text;
    if (!rich?.length) continue;
    const text = rich.map((i) => i.text?.content ?? '').join('');
    if (text.trim() === '') continue;
    const items = splitText(text, TEXT_LIMIT).map((part) => ({ type: 'text', text: { content: part } }));
    out.push(...textBlocks('paragraph', items));
  }
  return out;
}

/**
 * HTML の本文の文字数（空白を除く）。要約だけの記事かどうかの判定に使う。
 * @param {string} html
 */
export function contentLength(html) {
  return textContent(parseHtml(String(html ?? '').slice(0, MAX_HTML_CHARS))).replace(/\s+/g, '').length;
}

/**
 * Notion へ送るブロックを、1 リクエストの上限（100 ブロック・1000 要素・500KB）に収まるように分ける。
 * @param {Block[]} blocks
 * @param {{ maxItems?: number, maxElements?: number, maxBytes?: number }} [limits]
 * @returns {Block[][]}
 */
export function chunkBlocks(blocks, limits = {}) {
  const maxItems = limits.maxItems ?? CHILDREN_LIMIT;
  const maxElements = limits.maxElements ?? 900;
  const maxBytes = limits.maxBytes ?? 400_000;
  const chunks = [];
  let current = [];
  let elements = 0;
  let bytes = 0;
  for (const b of blocks) {
    const e = countBlocks([b]);
    const size = Buffer.byteLength(JSON.stringify(b));
    if (current.length && (current.length >= maxItems || elements + e > maxElements || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      elements = 0;
      bytes = 0;
    }
    current.push(b);
    elements += e;
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
