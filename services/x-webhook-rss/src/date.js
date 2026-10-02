// IFTTT の CreatedAt は "October 02, 2026 at 10:15PM" 形式（IFTTT アカウントのタイムゾーン）。
// ISO 8601 で来た場合はそのまま解釈する。解釈できなければ null を返す。

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const IFTTT_PATTERN = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i;

function validDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {unknown} value
 * @param {string} tzOffset "+09:00" 形式
 * @returns {Date | null}
 */
export function parseCreatedAt(value, tzOffset = '+00:00') {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();

  const m = IFTTT_PATTERN.exec(text);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    const hour12 = Number(m[4]);
    if (!month || hour12 < 1 || hour12 > 12 || Number(m[5]) > 59) return null;
    const hour = (hour12 % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    const pad = (n) => String(n).padStart(2, '0');
    const d = validDate(`${m[3]}-${pad(month)}-${pad(day)}T${pad(hour)}:${m[5]}:00${tzOffset}`);
    // 2月31日のような存在しない日付（Date が繰り上げる）を拒否する
    if (!d) return null;
    const local = new Date(d.getTime() + offsetMinutes(tzOffset) * 60000);
    return local.getUTCDate() === day && local.getUTCMonth() + 1 === month ? d : null;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return validDate(text);
  return null;
}

function offsetMinutes(tzOffset) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tzOffset);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}
