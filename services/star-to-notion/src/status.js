// 稼働状況の要約（/status と cli.js status。scripts/monitor.sh が /status で異常を検知する）。
import { PROBLEM_STATES } from './db.js';

// 送れていない記事がこれより長く残っていたら異常
const UNSENT_LIMIT_MS = 24 * 3600_000;

/**
 * @param {import('./db.js').Db} db
 * @param {{ pollMinutes: number }} config
 * @param {Date} now
 */
export function statusReport(db, config, now) {
  const counts = db.counts();
  const report = {
    initializedAt: db.getMeta('initialized_at'),
    lastPollOkAt: db.getMeta('last_poll_ok_at'),
    lastNotionOkAt: db.getMeta('last_notion_ok_at'),
    minifluxError: db.getMeta('miniflux_error'),
    notionError: db.getMeta('notion_error'),
    oldestUnsentAt: db.oldestUnsent(),
    counts,
  };
  /** @type {string[]} */
  const problems = [];
  // 確認の間隔の 3 倍（最低 30 分）を超えて Miniflux を確認できていなければ異常
  const staleMs = Math.max(3 * config.pollMinutes, 30) * 60_000;
  const since = report.lastPollOkAt ?? db.getMeta('created_at');
  if (since && now.getTime() - Date.parse(since) > staleMs) {
    problems.push(`no successful check of Miniflux since ${since}`);
  }
  if (report.minifluxError) problems.push(`miniflux: ${report.minifluxError}`);
  if (report.notionError) problems.push(`notion: ${report.notionError}`);
  if (report.oldestUnsentAt && now.getTime() - Date.parse(report.oldestUnsentAt) > UNSENT_LIMIT_MS) {
    problems.push(`some starred entries have not been saved for more than 24 hours (since ${report.oldestUnsentAt})`);
  }
  const attention = PROBLEM_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  if (attention) {
    const detail = PROBLEM_STATES.map((s) => `${s}: ${counts[s]}`).join(', ');
    problems.push(`${attention} entr${attention === 1 ? 'y needs' : 'ies need'} attention (${detail}); see: node src/cli.js status`);
  }
  return { ok: problems.length === 0, problems, ...report };
}
