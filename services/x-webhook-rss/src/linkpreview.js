// 投稿本文のリンク（t.co）の先のページから、リンクカードの画像（og:image）を取り出す。
// 外部の URL を取得するため、内部ネットワークへの接続を拒否し（SSRF 対策）、時間・サイズ・リダイレクト回数を制限する。
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(net, prefix, 'ipv6');

/**
 * 内部ネットワーク・ループバック・リンクローカル・予約済みなど、外部から取得してはいけないアドレスか。
 * @param {string} address IP アドレス
 */
export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    // IPv4 射影アドレス（::ffff:10.0.0.1）は IPv4 として判定する
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true;
}

// 投稿の写真・動画（x.com のページ）はログインなしでは画像を取れないため取りに行かない
const SKIP_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co)$/i;

/**
 * 本文から、リンクカードの候補になる URL（t.co の短縮 URL）を取り出す。
 * @param {string} text
 * @returns {string[]}
 */
export function extractLinks(text) {
  return [...new Set(String(text).match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? [])];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };

function decodeEntities(value) {
  return value.replace(/&(#?[A-Za-z0-9]+);/g, (all, name) => ENTITIES[name] ?? all);
}

const IMAGE_KEYS = ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'];

/**
 * HTML の meta タグから og:image（なければ twitter:image）を取り出し、絶対 URL にして返す。
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string | null}
 */
export function findImageInHtml(html, baseUrl) {
  const values = {};
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = {};
    for (const m of tag.matchAll(/([A-Za-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (IMAGE_KEYS.includes(key) && attrs.content && !(key in values)) {
      values[key] = decodeEntities(attrs.content.trim());
    }
  }
  const raw = IMAGE_KEYS.map((k) => values[k]).find(Boolean);
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} PreviewOptions
 * @property {number} [timeoutMs]     1 つのリンクの取得（リダイレクトを含む）の上限
 * @property {number} [maxBytes]      読み込む HTML の上限
 * @property {number} [maxRedirects]
 * @property {number[]} [allowedPorts]
 * @property {(address: string) => boolean} [isBlocked]  テストで差し替える
 * @property {string} [userAgent]
 */

/**
 * @param {PreviewOptions} [options]
 */
export function createLinkPreview({
  timeoutMs = 8000,
  maxBytes = 1024 * 1024,
  maxRedirects = 5,
  allowedPorts = [80, 443],
  isBlocked = isBlockedAddress,
  userAgent = 'Mozilla/5.0 (compatible; freetier-reader x-webhook-rss; link preview)',
} = {}) {
  // 名前解決の結果をすべて検査してから接続する（検査したアドレスで接続するので DNS の再バインドも防げる）
  function guardedLookup(hostname, opts, callback) {
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const blocked = addresses.find((a) => isBlocked(a.address));
      if (blocked) return callback(new Error(`refusing to connect to non-public address ${blocked.address} (${hostname})`));
      if (opts && opts.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  }

  /**
   * @param {URL} url
   * @param {AbortSignal} signal
   * @returns {Promise<{ status: number, location?: string, body?: string }>}
   */
  function requestOnce(url, signal) {
    return new Promise((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // IP を直接指定した URL は名前解決を通らないため、ここで検査する
      if (isIP(host) && isBlocked(host)) {
        reject(new Error(`refusing to connect to non-public address ${host}`));
        return;
      }
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(url, {
        lookup: guardedLookup,
        signal,
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
      }, (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, location: res.headers.location });
          return;
        }
        if (status !== 200 || !/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
          res.resume();
          resolve({ status });
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (size >= maxBytes) return;
          chunks.push(chunk.subarray(0, Math.min(chunk.length, maxBytes - size)));
          size += chunk.length;
          // 上限までで打ち切る（og:image は通常 <head> にある）
          if (size >= maxBytes) {
            res.destroy();
            resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
          }
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  /**
   * URL をたどってページを取得し、画像の URL を返す。x.com などのページは取りに行かない。
   * @param {string} startUrl
   * @returns {Promise<string | null>}
   */
  async function imageForUrl(startUrl) {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = new URL(startUrl);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!allowedPorts.includes(port)) return null;
      if (url.username || url.password) return null;
      // 短縮 URL（最初の t.co）だけはたどり、それ以外の X のページは取りに行かない
      if (SKIP_HOSTS.test(url.hostname) && !(hop === 0 && url.hostname === 't.co')) return null;

      const res = await requestOnce(url, signal);
      if (res.location) {
        url = new URL(res.location, url);
        continue;
      }
      return res.body ? findImageInHtml(res.body, url.href) : null;
    }
    return null;
  }

  return {
    /**
     * 本文のリンクを順に試し、最初に見つかった画像の URL を返す。取得に失敗したリンクは飛ばす。
     * @param {string} text
     * @param {(link: string, err: Error) => void} [onError]
     * @returns {Promise<string | null>}
     */
    async findImage(text, onError = () => {}) {
      for (const link of extractLinks(text)) {
        try {
          const image = await imageForUrl(link);
          if (image) return image;
        } catch (err) {
          onError(link, /** @type {Error} */ (err));
        }
      }
      return null;
    },
    imageForUrl,
  };
}

/**
 * 画像をまだ取得していない投稿を 1 件ずつ処理する。Webhook への応答を待たせないよう、受信とは別に動かす。
 * @param {{
 *   db: Pick<ReturnType<import('./db.js').openDb>, 'pendingPreviews' | 'setPreview'>,
 *   preview: Pick<ReturnType<typeof createLinkPreview>, 'findImage'>,
 *   log?: Pick<Console, 'warn' | 'error'>,
 *   batchSize?: number,
 * }} deps
 */
export function createPreviewWorker({ db, preview, log = console, batchSize = 20 }) {
  let running = null;
  let again = false;

  async function drain() {
    for (;;) {
      const pending = db.pendingPreviews(batchSize);
      if (pending.length === 0) return;
      for (const post of pending) {
        let image = null;
        try {
          image = await preview.findImage(post.text, (link, err) => {
            log.warn(`link preview failed: ${link}: ${err.message}`);
          });
        } catch (err) {
          log.error('link preview error:', err);
        }
        // 見つからない・失敗した場合も処理済みにする（同じ投稿で何度も外部へ取りに行かない）
        db.setPreview(post.link, image);
      }
    }
  }

  return {
    /** 処理を始める。処理中に呼ばれたら、終わった後にもう一度確認する */
    kick() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          await drain();
        } while (again);
      })().catch((err) => log.error('link preview worker error:', err))
        .finally(() => { running = null; });
      return running;
    },
  };
}
