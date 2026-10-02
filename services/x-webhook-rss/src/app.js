import { createHash, timingSafeEqual } from 'node:crypto';
import { buildAtom } from './atom.js';
import { parseCreatedAt } from './date.js';

const MAX_BODY_BYTES = 64 * 1024;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const LINK_PATTERN = /^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/;

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function tokenMatches(given, expected) {
  return timingSafeEqual(digest(given), digest(expected));
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
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
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parsePayload(raw, contentType = '') {
  if (contentType.includes('application/json')) {
    return JSON.parse(raw);
  }
  // IFTTT では本文を <<<{{Text}}>>> で URL エンコードして送る form 形式を推奨（docs/ifttt.md）
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * @param {{
 *   db: ReturnType<import('./db.js').openDb>,
 *   config: { webhookToken: string, allowedUsers: Set<string>, maxItems: number, tzOffset: string, publicBaseUrl: string },
 *   now?: () => Date,
 * }} deps
 */
export function createApp({ db, config, now = () => new Date() }) {
  async function handleHook(req, res, token) {
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');
    if (!tokenMatches(token, config.webhookToken)) return send(res, 404, 'not found');

    let payload;
    try {
      payload = parsePayload(await readBody(req), req.headers['content-type']);
    } catch (err) {
      return send(res, err.status ?? 400, err.status ? err.message : 'invalid payload');
    }

    const username = String(payload.username ?? '').trim().replace(/^@/, '');
    const link = String(payload.link ?? '').trim();
    const text = String(payload.text ?? '');
    if (!USERNAME_PATTERN.test(username)) return send(res, 400, 'invalid username');
    if (!LINK_PATTERN.test(link)) return send(res, 400, 'invalid link');

    const key = username.toLowerCase();
    if (config.allowedUsers.size > 0 && !config.allowedUsers.has(key)) {
      return send(res, 403, 'username not allowed');
    }

    const receivedAt = now();
    const createdAt = parseCreatedAt(payload.created_at, config.tzOffset) ?? receivedAt;
    const created = db.addPost({
      username: key,
      link,
      text,
      embed: payload.embed ? String(payload.embed) : null,
      createdAt: createdAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
    }, config.maxItems);

    return send(res, created ? 201 : 200, created ? 'created' : 'duplicate');
  }

  function handleFeed(req, res, username) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (!USERNAME_PATTERN.test(username)) return send(res, 404, 'not found');
    const key = username.toLowerCase();
    const posts = db.listPosts(key, config.maxItems);
    const selfUrl = `${config.publicBaseUrl}/feeds/x/${key}.xml`;
    return send(res, 200, buildAtom({ username: key, selfUrl, posts }), 'application/atom+xml; charset=utf-8');
  }

  return async function handler(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/healthz') {
      return send(res, 200, JSON.stringify({ ok: true, lastReceivedAt: db.lastReceivedAt() }), 'application/json');
    }

    const hook = /^\/hook\/x\/([^/]+)$/.exec(pathname);
    if (hook) return handleHook(req, res, decodeURIComponent(hook[1]));

    const feed = /^\/feeds\/x\/([^/]+)\.xml$/.exec(pathname);
    if (feed) return handleFeed(req, res, decodeURIComponent(feed[1]));

    return send(res, 404, 'not found');
  };
}
