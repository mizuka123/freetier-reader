// 管理コマンド（docker compose exec star-to-notion node src/cli.js <command>）。
//   status                 状態の要約と、確認が必要な記事
//   setup-notion           Notion のデータベースに足りないプロパティを追加する
//   backfill <N> | --all   導入前からスターが付いていた記事を、新しいものから N 件（または全部）送信待ちにする
//   retry <ID>             failed / missing / review / ignored / baseline の記事を送信待ちに戻す
//   ack <ID> | --all       failed / missing / review の記事を確認済み（ignored）にする（監視の異常から外す）
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { PROBLEM_STATES, openDb } from './db.js';
import { createNotion } from './notion.js';
import { schemaChanges } from './page.js';
import { statusReport } from './status.js';

const RETRYABLE_STATES = ['failed', 'missing', 'review', 'ignored', 'baseline'];
const USAGE = 'usage: node src/cli.js status | setup-notion | backfill <N>|--all | retry <ID> | ack <ID>|--all';

class UsageError extends Error {}

function positive(raw) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(USAGE);
  return n;
}

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {Pick<Console, 'log' | 'error'>} out
 * @returns {Promise<number>} 終了コード
 */
export async function main(args, env = process.env, out = console) {
  const [command, arg] = args;
  try {
    if (command === 'setup-notion') return await setupNotion(env, out);
    if (!['status', 'backfill', 'retry', 'ack'].includes(command)) throw new UsageError(USAGE);
    const db = openDb(env.DB_PATH || '/data/star-to-notion.db');
    try {
      return run(db, command, arg, env, out);
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof UsageError) {
      out.error(err.message);
      return 2;
    }
    throw err;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {Pick<Console, 'log' | 'error'>} out
 */
async function setupNotion(env, out) {
  const config = loadConfig(env);
  const notion = createNotion({ token: config.notionToken });
  const dsId = await notion.dataSourceId(config.notionDatabaseId);
  const ds = await notion.getDataSource(dsId);
  const changes = schemaChanges(ds?.properties ?? {});
  if (Object.keys(changes).length === 0) {
    out.log('the Notion database already has all properties');
    return 0;
  }
  await notion.updateDataSource(dsId, changes);
  out.log(`updated the Notion database: ${Object.keys(changes).join(', ')}`);
  return 0;
}

/**
 * @param {import('./db.js').Db} db
 * @param {string} command
 * @param {string | undefined} arg
 * @param {Record<string, string | undefined>} env
 * @param {Pick<Console, 'log' | 'error'>} out
 */
function run(db, command, arg, env, out) {
  switch (command) {
    case 'status': {
      const report = statusReport(db, { pollMinutes: Number(env.STAR_POLL_MINUTES) || 5 }, new Date());
      out.log(JSON.stringify(report, null, 2));
      const rows = db.list([...PROBLEM_STATES, 'pending', 'sending'], 50);
      if (rows.length) out.log('\nentry\tstate\tattempts\tnext attempt\tlast error');
      for (const r of rows) {
        out.log(`${r.entry_id}\t${r.state}\t${r.attempts}\t${r.next_attempt_at ?? '-'}\t${r.last_error ?? '-'}`);
      }
      return report.ok ? 0 : 1;
    }
    case 'backfill': {
      const limit = arg === '--all' ? Number.MAX_SAFE_INTEGER : positive(arg);
      const n = db.backfill(limit);
      out.log(`${n} entr${n === 1 ? 'y' : 'ies'} will be sent on the next run (${db.counts().baseline} left in baseline)`);
      return 0;
    }
    case 'retry': {
      const id = positive(arg);
      const row = db.get(id);
      if (!row) {
        out.error(`entry ${id} is not recorded (star it in Miniflux first)`);
        return 1;
      }
      if (!RETRYABLE_STATES.includes(row.state)) {
        out.error(`entry ${id} is ${row.state}; only ${RETRYABLE_STATES.join(' / ')} can be retried`);
        return 1;
      }
      db.reset(id);
      out.log(`entry ${id} will be sent on the next run`);
      return 0;
    }
    case 'ack': {
      const rows = arg === '--all' ? db.list(PROBLEM_STATES, Number.MAX_SAFE_INTEGER) : [db.get(positive(arg))];
      let n = 0;
      for (const row of rows) {
        if (row && PROBLEM_STATES.includes(row.state)) {
          db.setState(row.entry_id, 'ignored', row.last_error);
          n++;
        }
      }
      out.log(`${n} entr${n === 1 ? 'y was' : 'ies were'} marked as ignored`);
      return 0;
    }
    default:
      throw new UsageError(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
