import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTION_VERSION, NotionError, createNotion } from '../src/notion.js';

const TOKEN = 'dummy-notion-token-for-tests';

/**
 * 呼び出しを記録し、用意した応答を順に返す fetch
 * @param {Array<{ status: number, body?: unknown, headers?: Record<string, string> } | Error>} responses
 */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status, headers: next.headers,
    });
  };
  return { fn, calls };
}

const client = (responses, opts = {}) => {
  const f = fakeFetch(responses);
  const sleeps = [];
  const notion = createNotion({ token: TOKEN, fetch: f.fn, sleep: async (ms) => { sleeps.push(ms); }, minIntervalMs: 0, ...opts });
  return { notion, calls: f.calls, sleeps };
};

async function rejects(promise, check) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof NotionError);
    check(err);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
}

test('sends the version header and token, and creates a page under the data source', async () => {
  const { notion, calls } = client([{ status: 200, body: { id: 'page-1' } }]);
  const id = await notion.createPage('ds-1', { a: 1 }, [{ type: 'divider', divider: {} }]);
  assert.equal(id, 'page-1');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.notion.com/v1/pages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Notion-Version'], NOTION_VERSION);
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(init.body).parent, { type: 'data_source_id', data_source_id: 'ds-1' });
});

test('dataSourceId requires exactly one data source', async () => {
  const { notion, calls } = client([{ status: 200, body: { data_sources: [{ id: 'ds-1', name: 'a' }] } }]);
  assert.equal(await notion.dataSourceId('db-1'), 'ds-1');
  assert.equal(calls[0].url, 'https://api.notion.com/v1/databases/db-1');
  for (const sources of [[], [{ id: 'ds-1' }, { id: 'ds-2' }]]) {
    const c = client([{ status: 200, body: { data_sources: sources } }]);
    await rejects(c.notion.dataSourceId('db-1'), (e) => assert.equal(e.kind, 'fatal'));
  }
});

test('404 on page operations is marked as a page-level problem', async () => {
  for (const call of [(n) => n.getPage('p'), (n) => n.updatePage('p', {}), (n) => n.trashPage('p'), (n) => n.appendChildren('p', [])]) {
    const { notion } = client([{ status: 404, body: { code: 'object_not_found' } }]);
    await rejects(call(notion), (e) => {
      assert.equal(e.kind, 'not_found');
      assert.equal(e.resource, 'page');
    });
  }
  const { notion } = client([{ status: 404, body: { code: 'object_not_found' } }]);
  await rejects(notion.query('ds', {}), (e) => assert.equal(e.resource, undefined));
});

test('trashPage and appendChildren send the expected requests', async () => {
  const { notion, calls } = client([{ status: 200, body: {} }, { status: 200, body: {} }]);
  await notion.trashPage('p-1');
  await notion.appendChildren('p-1', [{ type: 'divider', divider: {} }]);
  assert.equal(calls[0].url, 'https://api.notion.com/v1/pages/p-1');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { in_trash: true });
  assert.equal(calls[1].url, 'https://api.notion.com/v1/blocks/p-1/children');
  assert.equal(JSON.parse(calls[1].init.body).children.length, 1);
});

test('429 within the limit is retried after Retry-After', async () => {
  const { notion, calls, sleeps } = client([
    { status: 429, body: { code: 'rate_limited' }, headers: { 'retry-after': '2' } },
    { status: 200, body: { results: [] } },
  ]);
  assert.deepEqual(await notion.query('ds', {}), []);
  assert.equal(calls.length, 2);
  assert.ok(sleeps.some((ms) => ms >= 2000 && ms < 3000));
});

test('429 longer than the in-process limit is raised as rate_limited', async () => {
  const { notion, calls } = client([{ status: 429, body: { code: 'rate_limited', additional_data: { retry_after: '120' } } }]);
  await rejects(notion.query('ds', {}), (e) => {
    assert.equal(e.kind, 'rate_limited');
    assert.equal(e.retryAfter, 120);
  });
  assert.equal(calls.length, 1);
});

test('blocked requests are fatal and not retried', async () => {
  const { notion, calls } = client([{ status: 429, body: { code: 'rate_limited', additional_data: { rate_limit_reason: 'public_api_request_blocked' } } }]);
  await rejects(notion.query('ds', {}), (e) => assert.equal(e.kind, 'fatal'));
  assert.equal(calls.length, 1);
});

test('503 with a committed resource is reported so the caller does not repeat the write', async () => {
  const { notion } = client([{ status: 503, body: { code: 'service_unavailable', additional_data: { retry_guidance: 'read', committed_resource_id: 'page-9' } } }]);
  await rejects(notion.createPage('ds', {}, []), (e) => {
    assert.equal(e.kind, 'uncertain');
    assert.equal(e.committedResourceId, 'page-9');
  });
});

test('classification of other errors', async () => {
  const cases = [
    [{ status: 500 }, 'POST', 'uncertain'],
    [{ status: 502 }, 'GET', 'retryable'],
    [{ status: 502 }, 'POST', 'uncertain'],
    [{ status: 503 }, 'POST', 'uncertain'],
    [{ status: 408 }, 'GET', 'retryable'],
    [{ status: 400, body: { code: 'validation_error' } }, 'POST', 'invalid'],
    [{ status: 401, body: { code: 'unauthorized' } }, 'GET', 'fatal'],
    [{ status: 404, body: { code: 'object_not_found' } }, 'GET', 'not_found'],
  ];
  for (const [response, method, kind] of cases) {
    const { notion } = client([response]);
    const call = method === 'GET' ? notion.getPage('p') : notion.createPage('ds', {}, []);
    await rejects(call, (e) => assert.equal(e.kind, kind, `${response.status} ${method}`));
  }
  const limit = client([{ status: 403, body: { code: 'restricted_resource', additional_data: { block_limit: 'block_creation' } } }]);
  await rejects(limit.notion.appendChildren('p', []), (e) => {
    assert.equal(e.kind, 'fatal');
    assert.equal(e.blockLimit, true);
  });
});

test('409 is retried once', async () => {
  const { notion, calls } = client([{ status: 409, body: { code: 'conflict_error' } }, { status: 200, body: {} }]);
  await notion.updatePage('p', {});
  assert.equal(calls.length, 2);
  const twice = client([{ status: 409 }, { status: 409 }]);
  await rejects(twice.notion.updatePage('p', {}), (e) => assert.equal(e.kind, 'retryable'));
  assert.equal(twice.calls.length, 2);
});

test('429 without Retry-After uses a default wait', async () => {
  const { notion } = client([{ status: 429, body: { code: 'rate_limited' } }], { maxRateLimitWaitSec: 0 });
  await rejects(notion.query('ds', {}), (e) => assert.equal(e.retryAfter, 30));
});

test('network errors: GET is retryable, writes are uncertain', async () => {
  const get = client([new TypeError('fetch failed')]);
  await rejects(get.notion.getPage('p'), (e) => assert.equal(e.kind, 'retryable'));
  const post = client([new TypeError('fetch failed')]);
  await rejects(post.notion.createPage('ds', {}, []), (e) => assert.equal(e.kind, 'uncertain'));
});

test('requests are spaced out', async () => {
  const sleeps = [];
  const f = fakeFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);
  const notion = createNotion({ token: TOKEN, fetch: f.fn, sleep: async (ms) => { sleeps.push(ms); }, minIntervalMs: 400 });
  await notion.getPage('a');
  await notion.getPage('b');
  assert.ok(sleeps.length === 1 && sleeps[0] > 300);
});
