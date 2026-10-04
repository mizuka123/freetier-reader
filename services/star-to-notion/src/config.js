// 環境変数から設定を読み込み、不正な値は起動時にエラーにする。
// 秘密値（NOTION_TOKEN / STAR_MINIFLUX_API_KEY）はエラーメッセージにも出さない。

function intInRange(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env, name, fallback) {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false (got "${env[name]}")`);
}

function secret(env, name) {
  const value = (env[name] ?? '').trim();
  if (value === '' || value === 'CHANGE_ME') {
    throw new Error(`${name} is not set (docs/notion.md)`);
  }
  if (/\s/.test(value)) throw new Error(`${name} must not contain whitespace`);
  return value;
}

function httpUrl(env, name, fallback) {
  const raw = (env[name] || fallback).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http(s) URL (got "${raw}")`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http(s) URL (got "${raw}")`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Notion のデータベース ID を取り出す。ID そのもの（ハイフンあり・なし）と、データベースの URL を受け付ける。
 * @param {string | undefined} raw
 * @returns {string | null} ハイフン付きの UUID 形式
 */
export function parseNotionId(raw) {
  const value = String(raw ?? '').trim();
  let hex;
  if (/^https?:\/\//i.test(value)) {
    let path;
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
    // URL はパスの末尾（「タイトル-<32 桁>」）から取り出す。?v= はビューの ID なので見ない
    hex = path.split('/').pop()?.match(/(?:^|-)([0-9a-f]{32})$/i)?.[1];
  } else {
    const compact = value.replace(/-/g, '');
    if (/^[0-9a-f]{32}$/i.test(compact)) hex = compact;
  }
  if (!hex) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} dbPath
 * @property {string} notionToken
 * @property {string} notionDatabaseId   ハイフン付きの UUID 形式
 * @property {string} minifluxUrl        サービスから Miniflux へ接続する URL（compose 内部）
 * @property {string} minifluxApiKey
 * @property {string} minifluxPublicUrl  Miniflux の BASE_URL（画像のプロキシ URL を元に戻すのに使う）
 * @property {number} pollMinutes
 * @property {boolean} fetchFullContent  本文が短いときに fetch-content で全文化を試すか
 * @property {number} minContentChars    この文字数未満の本文を「短い」とみなす
 * @property {number} maxBlocks          1 記事で Notion に送るブロック数の上限（入れ子も数える）
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function loadConfig(env) {
  const notionDatabaseId = parseNotionId(env.NOTION_DATABASE_ID);
  if (!notionDatabaseId) {
    throw new Error('NOTION_DATABASE_ID must be a Notion database ID or URL (docs/notion.md)');
  }
  return {
    port: intInRange(env, 'PORT', 8080, 1, 65535),
    dbPath: env.DB_PATH || '/data/star-to-notion.db',
    notionToken: secret(env, 'NOTION_TOKEN'),
    notionDatabaseId,
    minifluxUrl: httpUrl(env, 'MINIFLUX_URL', 'http://miniflux:8080'),
    minifluxApiKey: secret(env, 'STAR_MINIFLUX_API_KEY'),
    minifluxPublicUrl: httpUrl(env, 'MINIFLUX_PUBLIC_URL', 'http://localhost'),
    pollMinutes: intInRange(env, 'STAR_POLL_MINUTES', 5, 1, 1440),
    fetchFullContent: bool(env, 'STAR_FETCH_FULL_CONTENT', true),
    minContentChars: intInRange(env, 'STAR_MIN_CONTENT_CHARS', 500, 0, 100000),
    maxBlocks: intInRange(env, 'STAR_MAX_BLOCKS', 1000, 50, 5000),
  };
}
