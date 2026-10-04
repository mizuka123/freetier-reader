// Notion のデータベースのプロパティ（列）と、1 記事分のページの組み立て。
import { CONVERTER_VERSION, chunkBlocks, htmlToBlocks, safeUrl, toPlainBlocks } from './blocks.js';

/** データベースに必要なプロパティ（名前と型） */
export const PROPERTIES = {
  title: { name: 'タイトル', type: 'title' },
  url: { name: 'URL', type: 'url' },
  feed: { name: 'フィード', type: 'select' },
  published: { name: '公開日', type: 'date' },
  saved: { name: '保存日', type: 'date' },
  entryId: { name: 'Miniflux ID', type: 'number' },
  status: { name: '状態', type: 'select' },
  syncId: { name: '同期 ID', type: 'rich_text' },
};

/**
 * 「状態」の値。保存中のページは、送信の途中で止まった作りかけのもの
 * @type {Record<'sending' | 'full' | 'plain' | 'minimal', string>}
 */
export const STATUS = { sending: '保存中', full: '保存済み', plain: '簡易保存', minimal: '本文なし' };
const STATUS_COLORS = { 保存中: 'gray', 保存済み: 'green', 簡易保存: 'yellow', 本文なし: 'red' };

/** @typedef {'full' | 'plain' | 'minimal'} Mode */
export const MODES = /** @type {Mode[]} */ (['full', 'plain', 'minimal']);

/**
 * データベースのプロパティが揃っているか調べる。
 * @param {Record<string, { type: string }> | undefined} properties  data source の properties
 * @returns {string[]} 問題点（空なら OK）
 */
export function checkSchema(properties) {
  const problems = [];
  for (const { name, type } of Object.values(PROPERTIES)) {
    const actual = properties?.[name];
    if (!actual) problems.push(`missing property "${name}" (${type})`);
    else if (actual.type !== type) problems.push(`property "${name}" must be ${type} (is ${actual.type})`);
  }
  return problems;
}

/**
 * 足りないプロパティを追加する変更内容を作る（cli.js setup-notion）。
 * タイトルの列は名前だけを変える。型の違う同名の列があれば、何も変えずにエラーにする。
 * @param {Record<string, { type: string }>} properties
 * @returns {Record<string, unknown>} PATCH /v1/data_sources/{id} の properties（変更不要なら空）
 */
export function schemaChanges(properties) {
  /** @type {Record<string, unknown>} */
  const changes = {};
  const conflicts = [];
  for (const { name, type } of Object.values(PROPERTIES)) {
    const actual = properties[name];
    if (actual) {
      if (actual.type !== type) conflicts.push(`property "${name}" must be ${type} (is ${actual.type}); rename or delete it in Notion`);
      continue;
    }
    if (type === 'title') {
      const current = Object.entries(properties).find(([, p]) => p.type === 'title')?.[0];
      if (current) changes[current] = { name };
      continue;
    }
    /** @type {Record<string, unknown>} */
    let config = {};
    if (type === 'number') config = { format: 'number' };
    if (name === PROPERTIES.status.name) {
      config = { options: Object.entries(STATUS_COLORS).map(([option, color]) => ({ name: option, color })) };
    }
    changes[name] = { name, type, [type]: config };
  }
  if (conflicts.length) throw new Error(conflicts.join('; '));
  return changes;
}

const text = (content) => [{ type: 'text', text: { content } }];

function selectName(value) {
  // セレクトの選択肢にカンマは使えない
  const name = String(value).replace(/,/g, '，').replace(/\s+/g, ' ').trim().slice(0, 100);
  return name === '' ? null : { name };
}

function isoDate(value) {
  const t = Date.parse(value);
  // Miniflux は日付がない記事に 0001-01-01 を入れる
  if (!Number.isFinite(t) || new Date(t).getUTCFullYear() < 1971) return null;
  return { start: new Date(t).toISOString() };
}

/**
 * ページのプロパティを作る。
 * @param {import('./miniflux.js').Entry} entry
 * @param {{ syncId: string, savedAt: Date, status: string }} info
 */
export function pageProperties(entry, info) {
  const title = entry.title.replace(/\s+/g, ' ').trim() || entry.url || '(無題)';
  return {
    [PROPERTIES.title.name]: { title: text(title.slice(0, 2000)) },
    [PROPERTIES.url.name]: { url: safeUrl(entry.url) },
    [PROPERTIES.feed.name]: { select: selectName(entry.feedTitle) },
    [PROPERTIES.published.name]: { date: isoDate(entry.publishedAt) },
    [PROPERTIES.saved.name]: { date: { start: info.savedAt.toISOString() } },
    [PROPERTIES.entryId.name]: { number: entry.id },
    [PROPERTIES.status.name]: { select: { name: info.status } },
    [PROPERTIES.syncId.name]: { rich_text: text(info.syncId) },
  };
}

const note = (content) => ({
  type: 'paragraph',
  paragraph: { rich_text: [{ type: 'text', text: { content }, annotations: { italic: true, color: 'gray' } }] },
});

/**
 * 1 記事分のページを組み立てる。
 * @param {import('./miniflux.js').Entry} entry
 * @param {string} content  本文の HTML
 * @param {Mode} mode  full: 変換したまま / plain: 文字だけの段落 / minimal: 本文なし（Notion が受け付けなかったとき）
 * @param {{ publicBaseUrl: string, maxBlocks: number, syncId: string, savedAt: Date }} options
 */
export function buildPage(entry, content, mode, options) {
  /** @type {Record<string, any>[]} */
  let body = [];
  let truncated = false;
  if (mode !== 'minimal') {
    const converted = htmlToBlocks(content, options);
    body = mode === 'plain' ? toPlainBlocks(converted.blocks).slice(0, options.maxBlocks) : converted.blocks;
    truncated = converted.truncated;
  }
  if (truncated) body.push(note('（長い記事のため、ここで省略しました。続きは元記事をご覧ください）'));
  if (mode === 'minimal') body.push(note('（本文を Notion に保存できませんでした。元記事をご覧ください）'));
  const url = safeUrl(entry.url);
  if (url) body.push({ type: 'divider', divider: {} }, { type: 'bookmark', bookmark: { url } });

  return {
    properties: pageProperties(entry, { syncId: options.syncId, savedAt: options.savedAt, status: STATUS.sending }),
    chunks: chunkBlocks(body),
    blockCount: body.length,
    finalStatus: STATUS[mode],
    converterVersion: mode === 'minimal' ? null : CONVERTER_VERSION,
  };
}

/**
 * ページのプロパティから値を読む。
 * @param {any} page  Notion のページ
 */
export function readPage(page) {
  const props = page?.properties ?? {};
  return {
    id: typeof page?.id === 'string' ? page.id : '',
    inTrash: page?.in_trash === true || page?.archived === true,
    syncId: (props[PROPERTIES.syncId.name]?.rich_text ?? []).map((t) => t?.plain_text ?? t?.text?.content ?? '').join(''),
    status: props[PROPERTIES.status.name]?.select?.name ?? null,
  };
}

/**
 * 「状態」の値から、保存が完了したページか（完了ならその形）を返す。
 * @param {string | null} status
 * @returns {Mode | null}
 */
export function completedMode(status) {
  for (const mode of MODES) if (STATUS[mode] === status) return mode;
  return null;
}
