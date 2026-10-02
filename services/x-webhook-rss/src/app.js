import { createHash, timingSafeEqual } from 'node:crypto';
import { buildAtom } from './atom.js';
import { USERNAME_PATTERN } from './config.js';
import { parseCreatedAt } from './date.js';

const MAX_BODY_BYTES = 64 * 1024;
const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,20})\/?$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function tokenMatches(given, expected) {
  return timingSafeEqual(digest(given), digest(expected));
}

function send(req, res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 応答を返せるよう接続は切らず、残りは読み捨てる
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, 'payload too large'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// IFTTT の <<<{{Ingredient}}>>> 記法がエスケープされずに届いた場合に備えて外側の記号を除去する
function unwrapIfttt(value) {
  const s = String(value ?? '');
  return s.startsWith('<<<') && s.endsWith('>>>') ? s.slice(3, -3) : s;
}

function parsePayload(raw, contentType = '') {
  let data;
  if (contentType.includes('application/json')) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid json');
    }
  } else {
    data = Object.fromEntries(new URLSearchParams(raw));
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'payload must be an object');
  }
  return data;
}

/** X の投稿 URL を検証し https://x.com/<user>/status/<id> に正規化する。不正なら null */
export function normalizeLink(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !X_HOSTS.has(url.hostname)) return null;
  const m = STATUS_PATH.exec(url.pathname);
  return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

/**
 * @param {{
 *   db: ReturnType<import('./db.js').openDb>,
 *   config: Pick<import('./config.js').Config, 'webhookToken' | 'allowedUsers' | 'maxItems' | 'tzOffset' | 'publicBaseUrl' | 'staleHours'>,
 *   now?: () => Date,
 *   log?: Pick<Console, 'warn' | 'error'>,
 * }} deps
 */
export function createApp({ db, config, now = () => new Date(), log = console }) {
  function reject(status, reason, username = '') {
    log.warn(`hook rejected: status=${status} reason=${reason}${username ? ` username=${username}` : ''}`);
    return new HttpError(status, reason);
  }

  // 不正トークンでの大量アクセスでログが溢れないよう、警告は 1 分に 1 回にまとめる
  let badTokenCount = 0;
  let badTokenLoggedAt = 0;
  function rejectBadToken() {
    badTokenCount += 1;
    const t = now().getTime();
    if (t - badTokenLoggedAt >= 60_000) {
      log.warn(`hook rejected: status=404 reason=bad token count=${badTokenCount}`);
      badTokenLoggedAt = t;
      badTokenCount = 0;
    }
    return new HttpError(404, 'not found');
  }

  async function handleHook(req, res, token) {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    // トークン不一致は存在しないパスと同じ応答にする（ログにトークンは出さない）
    if (!tokenMatches(token, config.webhookToken)) throw rejectBadToken();

    let payload;
    try {
      payload = parsePayload(await readBody(req), req.headers['content-type']);
    } catch (err) {
      if (err instanceof HttpError) throw reject(err.status, err.message);
      throw err;
    }

    const username = unwrapIfttt(payload.username).trim().replace(/^@/, '');
    const text = unwrapIfttt(payload.text);
    const rawCreatedAt = unwrapIfttt(payload.created_at);
    if (!USERNAME_PATTERN.test(username)) throw reject(400, 'invalid username');
    const link = normalizeLink(unwrapIfttt(payload.link));
    if (!link) throw reject(400, 'invalid link', username);

    const key = username.toLowerCase();
    if (config.allowedUsers.size > 0 && !config.allowedUsers.has(key)) {
      throw reject(403, 'username not allowed', key);
    }

    const receivedAt = now();
    let createdAt = parseCreatedAt(rawCreatedAt, config.tzOffset);
    if (!createdAt) {
      log.warn(`created_at could not be parsed, using received time: ${JSON.stringify(rawCreatedAt).slice(0, 80)}`);
      createdAt = receivedAt;
    }

    const result = db.addPost({
      username: key,
      link,
      text,
      createdAt: createdAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
    }, config.maxItems);
    // 重複・保持範囲外でも IFTTT からは正常に届いているので受信時刻を更新する
    db.recordWebhook(key, receivedAt.toISOString());

    const status = { created: 201, duplicate: 200, pruned: 200 }[result];
    return send(req, res, status, result);
  }

  function handleFeed(req, res, username) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (!USERNAME_PATTERN.test(username)) throw new HttpError(404, 'not found');
    const key = username.toLowerCase();
    const selfUrl = `${config.publicBaseUrl}/feeds/x/${key}.xml`;
    const body = req.method === 'HEAD' ? '' : buildAtom({ username: key, selfUrl, posts: db.listPosts(key, config.maxItems) });
    return send(req, res, 200, body, 'application/atom+xml; charset=utf-8');
  }

  // /status: IFTTT からの受信が途絶えていないか（監視用）。
  // 許可リストがあればアカウントごとに判定し、一部のアプレットだけ止まった場合も検知する。
  // 一度も受信していないアカウントは DB 作成時刻から数える。
  function handleStatus(req, res) {
    const createdAt = db.createdAt();
    const isStale = (since) => config.staleHours > 0
      && now().getTime() - Date.parse(since) > config.staleHours * 3600 * 1000;

    const lastWebhookAt = db.lastWebhookAt();
    const users = {};
    const staleUsers = [];
    for (const user of [...config.allowedUsers].sort()) {
      const last = db.lastWebhookAt(user);
      users[user] = last;
      if (isStale(last ?? createdAt)) staleUsers.push(user);
    }
    const stale = config.allowedUsers.size > 0 ? staleUsers.length > 0 : isStale(lastWebhookAt ?? createdAt);
    const body = { ok: !stale, stale, staleUsers, lastWebhookAt, users, createdAt };
    return send(req, res, stale ? 503 : 200, JSON.stringify(body), 'application/json');
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    // /healthz: プロセスと DB が動いているか（コンテナのヘルスチェック用。受信の有無には依存しない）
    if (pathname === '/healthz') {
      db.createdAt();
      return send(req, res, 200, JSON.stringify({ ok: true }), 'application/json');
    }
    if (pathname === '/status') return handleStatus(req, res);

    const hook = /^\/hook\/x\/([^/]+)$/.exec(pathname);
    if (hook) return handleHook(req, res, safeDecode(hook[1]));

    const feed = /^\/feeds\/x\/([^/]+)\.xml$/.exec(pathname);
    if (feed) return handleFeed(req, res, safeDecode(feed[1]));

    throw new HttpError(404, 'not found');
  }

  // どの例外でもプロセスを落とさず、応答を返す
  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(req, res, err.status, err.message);
        return;
      }
      log.error('unexpected error:', err);
      if (!res.headersSent) send(req, res, 500, 'internal error');
      else res.destroy();
    }
  };
}
