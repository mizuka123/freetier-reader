// Notion API のクライアント。呼び出しは 1 本ずつ間隔をあけて送り（平均 3 回/秒の制限を下回る）、
// エラーは「再試行してよいか」「書き込みが反映されたか分からないか」「サービス全体の異常か」に分類する。
// ログやエラーメッセージに、トークン・送った内容・応答の本文は出さない。

export const NOTION_VERSION = '2026-03-11';
const API = 'https://api.notion.com/v1';

/**
 * @typedef {'rate_limited' | 'retryable' | 'uncertain' | 'invalid' | 'fatal' | 'not_found'} ErrorKind
 *   rate_limited: 429 / 529。待ってから再試行する（送信全体を止める）
 *   retryable:    書き込まれていない一時的なエラー。後で再試行する
 *   uncertain:    書き込みが反映されたか分からない（POST / PATCH の 5xx・タイムアウト・接続断）
 *   invalid:      送った内容が受け付けられなかった（400）。同じ内容での再試行は無駄
 *   fatal:        トークン・権限・ブロック上限など、サービス全体の異常（401 / 403）
 *   not_found:    対象のページなどがない、または共有されていない（404）
 */

export class NotionError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: ErrorKind, status?: number, code?: string, retryAfter?: number, committedResourceId?: string, blockLimit?: boolean }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'NotionError';
    this.kind = info.kind;
    this.status = info.status;
    this.code = info.code;
    /** 次に試してよいまでの秒数 */
    this.retryAfter = info.retryAfter;
    /** 503 で「書き込みは反映済み」と返ったときの、作られたもの（ページ作成ならページ）の ID */
    this.committedResourceId = info.committedResourceId;
    /** ワークスペースのブロック数の上限に達した */
    this.blockLimit = info.blockLimit ?? false;
  }
}

function parseRetryAfter(res, body) {
  const header = Number(res.headers.get('retry-after'));
  if (res.headers.get('retry-after') !== null && Number.isFinite(header) && header >= 0) return header;
  const fromBody = Number(body?.additional_data?.retry_after);
  return Number.isFinite(fromBody) && fromBody >= 0 ? fromBody : 30;
}

/**
 * HTTP の応答をエラーに分類する。
 * @param {string} method
 * @param {Response} res
 * @param {any} body
 */
export function classify(method, res, body) {
  const status = res.status;
  const code = typeof body?.code === 'string' ? body.code : undefined;
  const extra = body?.additional_data ?? {};
  const write = method !== 'GET';
  const message = `notion ${method} failed: ${status}${code ? ` ${code}` : ''}`;
  if (status === 429 || status === 529) {
    // 規約違反などでブロックされた場合は、待っても解消しない
    if (extra.rate_limit_reason === 'public_api_request_blocked') return new NotionError(message, { kind: 'fatal', status, code });
    return new NotionError(message, { kind: 'rate_limited', status, code, retryAfter: parseRetryAfter(res, body) });
  }
  if (status === 503 && write && typeof extra.committed_resource_id === 'string') {
    // 書き込みは反映済みで、応答だけが作れなかった。同じ書き込みを繰り返さず、反映されたものを読み直す
    return new NotionError(message, { kind: 'uncertain', status, code, committedResourceId: extra.committed_resource_id });
  }
  if (status === 409) return new NotionError(message, { kind: 'retryable', status, code });
  if (status >= 500) return new NotionError(message, { kind: write ? 'uncertain' : 'retryable', status, code });
  if (status === 401) return new NotionError(message, { kind: 'fatal', status, code });
  if (status === 403) {
    return new NotionError(message, { kind: 'fatal', status, code, blockLimit: extra.block_limit === 'block_creation' });
  }
  if (status === 404) return new NotionError(message, { kind: 'not_found', status, code });
  return new NotionError(message, { kind: 'invalid', status, code });
}

/**
 * @param {{
 *   token: string,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   minIntervalMs?: number,
 *   timeoutMs?: number,
 *   maxRateLimitWaitSec?: number,
 * }} options
 */
export function createNotion(options) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const minInterval = options.minIntervalMs ?? 400;
  const timeoutMs = options.timeoutMs ?? 60_000;
  // この秒数までの Retry-After はその場で待って再試行する（429 は書き込まれていないので安全）
  const maxWait = options.maxRateLimitWaitSec ?? 60;
  let last = 0;

  /**
   * @param {'GET' | 'POST' | 'PATCH'} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      let res;
      try {
        res = await doFetch(`${API}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Notion-Version': NOTION_VERSION,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err?.name === 'TimeoutError' ? 'timeout' : 'network error';
        throw new NotionError(`notion ${method} failed: ${reason}`, { kind: method === 'GET' ? 'retryable' : 'uncertain' });
      }
      let json = null;
      try {
        json = await res.json();
      } catch {
        // 本文が JSON でない（途中のプロキシのエラーページなど）
      }
      if (res.ok) return json;
      const error = classify(method, res, json);
      if (error.kind === 'rate_limited' && attempt < 3 && (error.retryAfter ?? 0) <= maxWait) {
        await sleep(((error.retryAfter ?? 1) + Math.random()) * 1000);
        continue;
      }
      if (error.kind === 'retryable' && error.status === 409 && attempt < 1) {
        await sleep(1000 + Math.random() * 1000);
        continue;
      }
      throw error;
    }
  }

  return {
    request,

    /**
     * データベースの最初のデータソースの ID を返す。
     * @param {string} databaseId
     * @returns {Promise<string>}
     */
    async dataSourceId(databaseId) {
      const db = await request('GET', `/databases/${databaseId}`);
      const id = db?.data_sources?.[0]?.id;
      if (typeof id !== 'string') throw new NotionError('notion database has no data source', { kind: 'fatal' });
      return id;
    },

    /** @param {string} dataSourceId */
    getDataSource(dataSourceId) {
      return request('GET', `/data_sources/${dataSourceId}`);
    },

    /**
     * @param {string} dataSourceId
     * @param {Record<string, unknown>} properties
     */
    updateDataSource(dataSourceId, properties) {
      return request('PATCH', `/data_sources/${dataSourceId}`, { properties });
    },

    /**
     * プロパティの値でページを探す（最大 100 件）。
     * @param {string} dataSourceId
     * @param {Record<string, unknown>} filter
     * @returns {Promise<any[]>}
     */
    async query(dataSourceId, filter) {
      const res = await request('POST', `/data_sources/${dataSourceId}/query`, { filter, page_size: 100 });
      return Array.isArray(res?.results) ? res.results : [];
    },

    /**
     * @param {string} dataSourceId
     * @param {Record<string, unknown>} properties
     * @param {unknown[]} children
     * @returns {Promise<string>} 作ったページの ID
     */
    async createPage(dataSourceId, properties, children) {
      const page = await request('POST', '/pages', {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
        children,
      });
      if (typeof page?.id !== 'string') throw new NotionError('notion returned no page id', { kind: 'uncertain' });
      return page.id;
    },

    /** @param {string} pageId */
    getPage(pageId) {
      return request('GET', `/pages/${pageId}`);
    },

    /**
     * @param {string} pageId
     * @param {Record<string, unknown>} properties
     */
    updatePage(pageId, properties) {
      return request('PATCH', `/pages/${pageId}`, { properties });
    },

    /** @param {string} pageId */
    trashPage(pageId) {
      return request('PATCH', `/pages/${pageId}`, { in_trash: true });
    },

    /**
     * @param {string} blockId
     * @param {unknown[]} children
     */
    appendChildren(blockId, children) {
      return request('PATCH', `/blocks/${blockId}/children`, { children });
    },
  };
}

/** @typedef {ReturnType<typeof createNotion>} Notion */
