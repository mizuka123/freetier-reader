// Miniflux がサニタイズした記事本文の HTML を、要素とテキストの木に変換する小さなパーサー。
// 入力は Miniflux の sanitizer（許可したタグと属性だけを整形して出力）を通っているため、HTML5 の全仕様は扱わない。
// 壊れた入力でも例外にせず、閉じタグの対応が取れなければ無視する。深さとノード数には上限を設ける。

/**
 * @typedef {{ type: 'text', text: string }} TextNode
 * @typedef {{ type: 'element', tag: string, attrs: Record<string, string>, children: Node[] }} ElementNode
 * @typedef {TextNode | ElementNode} Node
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
// 中身を記事の本文として扱わない要素（中身は読み飛ばす）
const RAW_TEXT_TAGS = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'title']);

const MAX_DEPTH = 64;
const MAX_NODES = 50000;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', times: '×', divide: '÷', yen: '¥', euro: '€', pound: '£', cent: '¢', deg: '°',
  sect: '§', para: '¶', shy: '­', zwj: '‍', zwnj: '‌', ensp: ' ', emsp: ' ', thinsp: ' ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', minus: '−', plusmn: '±', frac12: '½', hearts: '♥',
};

/**
 * 文字参照（&amp; &#39; &#x27; など）を文字に戻す。知らない名前はそのまま残す。
 * @param {string} value
 */
export function decodeEntities(value) {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (all, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      // NUL・サロゲート・範囲外は置換文字にする（HTML の仕様と同じ扱い）
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const ch = NAMED_ENTITIES[name];
    return ch === undefined ? all : ch;
  });
}

const ATTR_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const m of source.matchAll(ATTR_PATTERN)) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * HTML を木に変換する。
 * @param {string} html
 * @returns {ElementNode} 仮想のルート要素（tag: '#root'）
 */
export function parseHtml(html) {
  const input = String(html ?? '');
  /** @type {ElementNode} */
  const root = { type: 'element', tag: '#root', attrs: {}, children: [] };
  /** @type {ElementNode[]} */
  const stack = [root];
  let nodes = 0;
  let pos = 0;

  const current = () => stack[stack.length - 1];
  const pushText = (text) => {
    if (text === '' || nodes >= MAX_NODES) return;
    const parent = current();
    const last = parent.children[parent.children.length - 1];
    if (last?.type === 'text') {
      last.text += text;
    } else {
      parent.children.push({ type: 'text', text });
      nodes++;
    }
  };

  while (pos < input.length && nodes < MAX_NODES) {
    const lt = input.indexOf('<', pos);
    if (lt === -1) {
      pushText(decodeEntities(input.slice(pos)));
      break;
    }
    if (lt > pos) pushText(decodeEntities(input.slice(pos, lt)));

    // コメント・DOCTYPE・CDATA・処理命令は読み飛ばす
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      pos = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input[lt + 1] === '!' || input[lt + 1] === '?') {
      const end = input.indexOf('>', lt + 2);
      pos = end === -1 ? input.length : end + 1;
      continue;
    }

    const tagMatch = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(input.slice(lt, lt + 64));
    if (!tagMatch) {
      // タグとして解釈できない「<」は文字として扱う
      pushText('<');
      pos = lt + 1;
      continue;
    }
    const closing = tagMatch[1] === '/';
    const tag = tagMatch[2].toLowerCase();
    // 属性値の中の「>」で途切れないよう、引用符を考慮してタグの終わりを探す
    let i = lt + tagMatch[0].length;
    let quote = '';
    for (; i < input.length; i++) {
      const c = input[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    const inner = input.slice(lt + tagMatch[0].length, i);
    pos = i + 1;

    if (closing) {
      // 対応する開始タグがあればそこまで閉じる。なければ無視する
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].tag === tag) {
          stack.length = d;
          break;
        }
      }
      continue;
    }

    if (RAW_TEXT_TAGS.has(tag)) {
      const re = new RegExp(`</${tag}`, 'gi');
      re.lastIndex = pos;
      const end = re.exec(input)?.index;
      if (end === undefined) {
        pos = input.length;
      } else {
        const close = input.indexOf('>', end);
        pos = close === -1 ? input.length : close + 1;
      }
      continue;
    }

    // 段落やリスト項目の中で同じ要素が始まったら、前のものを閉じる（<p>a<p>b、<li>a<li>b）
    if (tag === 'p' || tag === 'li') {
      const stop = tag === 'li' ? new Set(['ul', 'ol']) : null;
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].tag === tag) {
          stack.length = d;
          break;
        }
        if (stop?.has(stack[d].tag)) break;
      }
    }

    /** @type {ElementNode} */
    const el = { type: 'element', tag, attrs: parseAttrs(inner.replace(/\/\s*$/, '')), children: [] };
    current().children.push(el);
    nodes++;
    const selfClosing = VOID_TAGS.has(tag) || /\/\s*$/.test(inner);
    // 深すぎる入れ子は、それ以上深くせずに今の階層へ並べる
    if (!selfClosing && stack.length <= MAX_DEPTH) stack.push(el);
  }
  return root;
}

/**
 * 要素の中のテキストを連結する（空白はそのまま。br は改行）。
 * @param {Node} node
 * @returns {string}
 */
export function textContent(node) {
  if (node.type === 'text') return node.text;
  let out = '';
  const walk = (n) => {
    if (n.type === 'text') {
      out += n.text;
      return;
    }
    if (n.tag === 'br') out += '\n';
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}
