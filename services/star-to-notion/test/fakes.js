// テスト用の Notion / Miniflux の偽物（メモリ上で動く）
import { MinifluxError } from '../src/miniflux.js';
import { NotionError } from '../src/notion.js';
import { PROPERTIES } from '../src/page.js';

export const FULL_SCHEMA = Object.fromEntries(Object.values(PROPERTIES).map(({ name, type }) => [name, { type }]));

const err = (kind, extra = {}) => new NotionError(`notion fake ${kind}`, { kind, ...extra });
export const notionErrors = {
  invalid: () => err('invalid', { status: 400, code: 'validation_error' }),
  uncertain: () => err('uncertain', { status: 500 }),
  committed: (id) => err('uncertain', { status: 503, committedResourceId: id }),
  rateLimited: (sec = 120) => err('rate_limited', { status: 429, retryAfter: sec }),
  unauthorized: () => err('fatal', { status: 401, code: 'unauthorized' }),
  blockLimit: () => err('fatal', { status: 403, code: 'restricted_resource', blockLimit: true }),
};

export class FakeNotion {
  constructor() {
    /** @type {Map<string, { id: string, properties: any, children: any[], in_trash: boolean }>} */
    this.pages = new Map();
    this.schema = { ...FULL_SCHEMA };
    /** @type {Array<{ method: string, error: () => Error, commit?: boolean }>} */
    this.failures = [];
    this.calls = [];
    this.seq = 0;
  }

  /**
   * 次に method が呼ばれたときに失敗させる。commit: true なら、書き込みを反映してから失敗する
   * @param {string} method
   * @param {() => Error} error
   * @param {{ commit?: boolean }} [opts]
   */
  fail(method, error, opts = {}) {
    this.failures.push({ method, error, ...opts });
  }

  #check(method) {
    this.calls.push(method);
    const i = this.failures.findIndex((f) => f.method === method);
    if (i === -1) return null;
    const f = this.failures.splice(i, 1)[0];
    if (!f.commit) throw f.error();
    return f;
  }

  live() {
    return [...this.pages.values()].filter((p) => !p.in_trash);
  }

  async dataSourceId() {
    this.#check('dataSourceId');
    return 'ds-1';
  }

  async getDataSource() {
    this.#check('getDataSource');
    return { properties: this.schema };
  }

  async query(_ds, filter) {
    this.#check('query');
    return [...this.pages.values()].filter((p) => {
      const prop = p.properties[filter.property];
      if (filter.rich_text) return (prop?.rich_text ?? []).map((t) => t.text.content).join('') === filter.rich_text.equals;
      if (filter.number) return prop?.number === filter.number.equals;
      return false;
    }).map((p) => structuredClone(p));
  }

  async createPage(_ds, properties, children) {
    const f = this.#check('createPage');
    const id = `page-${++this.seq}`;
    this.pages.set(id, { id, properties: structuredClone(properties), children: structuredClone(children), in_trash: false });
    if (f) throw f.error();
    return id;
  }

  async getPage(id) {
    this.#check('getPage');
    const p = this.pages.get(id);
    if (!p) throw err('not_found', { status: 404 });
    return structuredClone(p);
  }

  async updatePage(id, properties) {
    const f = this.#check('updatePage');
    Object.assign(this.pages.get(id).properties, structuredClone(properties));
    if (f) throw f.error();
    return {};
  }

  async trashPage(id) {
    this.#check('trashPage');
    this.pages.get(id).in_trash = true;
    return {};
  }

  async appendChildren(id, children) {
    const f = this.#check('appendChildren');
    this.pages.get(id).children.push(...structuredClone(children));
    if (f) throw f.error();
    return {};
  }
}

export class FakeMiniflux {
  constructor() {
    /** @type {Set<number>} */
    this.starred = new Set();
    /** @type {Map<number, import('../src/miniflux.js').Entry>} */
    this.entries = new Map();
    /** @type {Map<number, string>} */
    this.fullContent = new Map();
    this.fetchContentCalls = [];
    /** @type {Error | null} */
    this.failNext = null;
  }

  /**
   * @param {number} id
   * @param {Partial<import('../src/miniflux.js').Entry>} [fields]
   */
  add(id, fields = {}) {
    this.entries.set(id, {
      id,
      title: `Title ${id}`,
      url: `https://news.example.com/${id}`,
      content: `<p>${'本文'.repeat(300)}</p>`,
      publishedAt: '2026-10-01T09:00:00+09:00',
      feedTitle: 'Example, News',
      feedCrawler: false,
      ...fields,
    });
    return this;
  }

  star(...ids) {
    for (const id of ids) this.starred.add(id);
  }

  unstar(...ids) {
    for (const id of ids) this.starred.delete(id);
  }

  async starredIds() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return [...this.starred].sort((a, b) => b - a);
  }

  async entry(id) {
    const e = this.entries.get(id);
    if (!e) throw new MinifluxError('miniflux GET /entries/{id} failed: 404', { kind: 'not_found', status: 404 });
    return { ...e };
  }

  async fetchContent(id) {
    this.fetchContentCalls.push(id);
    const c = this.fullContent.get(id);
    if (c === undefined) throw new MinifluxError('miniflux GET /entries/{id}/fetch-content failed: 500', { kind: 'retryable', status: 500 });
    return c;
  }
}
