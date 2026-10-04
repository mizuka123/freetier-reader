// Miniflux API のクライアント（compose 内部の http://miniflux:8080 へ API キーで接続する）。
// 記事の応答には feed の Cookie・ユーザー名・パスワードなども含まれるため、必要な項目だけを取り出し、応答をログに出さない。

export class MinifluxError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'fatal' | 'not_found' | 'retryable', status?: number }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'MinifluxError';
    this.kind = info.kind;
    this.status = info.status;
  }
}

/**
 * @typedef {object} Entry  Notion に保存するのに使う項目だけ
 * @property {number} id
 * @property {string} title
 * @property {string} url
 * @property {string} content       サニタイズ済みの HTML（画像はメディアプロキシの URL になっていることがある）
 * @property {string} publishedAt
 * @property {string} feedTitle
 * @property {boolean} feedCrawler  フィードの「全文を取得」が有効か
 */

// 1 回に取得する ID の数（Miniflux の上限は 10000）
const IDS_PAGE = 10000;

/**
 * @param {{ baseUrl: string, apiKey: string, fetch?: typeof fetch, timeoutMs?: number, fetchContentTimeoutMs?: number }} options
 */
export function createMiniflux(options) {
  const doFetch = options.fetch ?? globalThis.fetch;

  /**
   * @param {string} path
   * @param {number} [timeoutMs]
   */
  async function get(path, timeoutMs = options.timeoutMs ?? 30_000) {
    const name = path.split('?')[0].replace(/\/\d+/g, '/{id}');
    let res;
    try {
      res = await doFetch(`${options.baseUrl}/v1${path}`, {
        headers: { 'X-Auth-Token': options.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : 'network error';
      throw new MinifluxError(`miniflux GET ${name} failed: ${reason}`, { kind: 'retryable' });
    }
    if (res.ok) return res.json();
    await res.body?.cancel();
    const message = `miniflux GET ${name} failed: ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new MinifluxError(message, { kind: 'fatal', status: res.status });
    if (res.status === 404) throw new MinifluxError(message, { kind: 'not_found', status: res.status });
    throw new MinifluxError(message, { kind: 'retryable', status: res.status });
  }

  return {
    /**
     * スターが付いている記事の ID をすべて返す。
     * @returns {Promise<number[]>}
     */
    async starredIds() {
      const ids = new Set();
      for (let offset = 0; ; offset += IDS_PAGE) {
        const res = await get(`/entries/ids?starred=true&limit=${IDS_PAGE}&offset=${offset}`);
        const page = Array.isArray(res?.entry_ids) ? res.entry_ids : [];
        for (const id of page) if (Number.isSafeInteger(id)) ids.add(id);
        // 走査中にスターが増減して取りこぼした分は、次の回で拾える（毎回、記録との差分を取るため）
        if (page.length < IDS_PAGE || offset + IDS_PAGE >= Number(res?.total ?? 0)) break;
      }
      return [...ids];
    },

    /**
     * @param {number} id
     * @returns {Promise<Entry>}
     */
    async entry(id) {
      const e = await get(`/entries/${id}`);
      return {
        id,
        title: typeof e?.title === 'string' ? e.title : '',
        url: typeof e?.url === 'string' ? e.url : '',
        content: typeof e?.content === 'string' ? e.content : '',
        publishedAt: typeof e?.published_at === 'string' ? e.published_at : '',
        feedTitle: typeof e?.feed?.title === 'string' ? e.feed.title : '',
        feedCrawler: e?.feed?.crawler === true,
      };
    },

    /**
     * 元記事のページから本文を取得する（Miniflux の記録は書き換えない）。
     * @param {number} id
     * @returns {Promise<string>}
     */
    async fetchContent(id) {
      const res = await get(`/entries/${id}/fetch-content`, options.fetchContentTimeoutMs ?? 60_000);
      return typeof res?.content === 'string' ? res.content : '';
    },
  };
}

/** @typedef {ReturnType<typeof createMiniflux>} Miniflux */
