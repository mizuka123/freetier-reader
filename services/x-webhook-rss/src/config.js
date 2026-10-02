// 環境変数から設定を読み込み、不正な値は起動時にエラーにする。

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const TZ_OFFSET_PATTERN = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;

function intInRange(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} dbPath
 * @property {string} webhookToken
 * @property {string} tzOffset       "+09:00" 形式
 * @property {Set<string>} allowedUsers  小文字化済み。空なら全員許可
 * @property {number} maxItems        アカウントごとの保持件数
 * @property {number} staleHours      最終受信からこの時間を超えたら /status が 503（0 なら無効）
 * @property {string} publicBaseUrl   フィードの self リンクに使うベース URL
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function loadConfig(env) {
  const webhookToken = env.X_WEBHOOK_TOKEN ?? '';
  if (webhookToken.length < 32 || webhookToken === 'CHANGE_ME') {
    throw new Error('X_WEBHOOK_TOKEN must be at least 32 characters (run scripts/init.sh)');
  }

  const tzOffset = env.X_IFTTT_TZ_OFFSET || '+09:00';
  if (!TZ_OFFSET_PATTERN.test(tzOffset)) {
    throw new Error(`X_IFTTT_TZ_OFFSET must look like +09:00 (got "${tzOffset}")`);
  }

  const allowedUsers = new Set();
  for (const item of (env.X_ALLOWED_USERS ?? '').split(',')) {
    const name = item.trim().replace(/^@/, '');
    if (name === '') continue;
    if (!USERNAME_PATTERN.test(name)) {
      throw new Error(`X_ALLOWED_USERS contains an invalid username: "${name}"`);
    }
    allowedUsers.add(name.toLowerCase());
  }

  return {
    port: intInRange(env, 'PORT', 8080, 1, 65535),
    dbPath: env.DB_PATH || '/data/x-webhook-rss.db',
    webhookToken,
    tzOffset,
    allowedUsers,
    maxItems: intInRange(env, 'X_MAX_ITEMS', 200, 1, 10000),
    staleHours: intInRange(env, 'X_STALE_HOURS', 72, 0, 24 * 365),
    publicBaseUrl: (env.X_FEED_BASE_URL || 'http://x-webhook-rss:8080').replace(/\/+$/, ''),
  };
}
