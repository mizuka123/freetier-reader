// IFTTT の CreatedAt は "October 02, 2026 at 10:15PM" 形式（IFTTT アカウントのタイムゾーン）。
// ISO 8601 で来た場合はそのまま解釈する。解釈できなければ null を返す。

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const IFTTT_PATTERN = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i;

/**
 * @param {string} value
 * @param {string} tzOffset "+09:00" 形式
 * @returns {Date | null}
 */
export function parseCreatedAt(value, tzOffset = '+00:00') {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();

  const m = IFTTT_PATTERN.exec(text);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) return null;
    let hour = Number(m[4]) % 12;
    if (m[6].toUpperCase() === 'PM') hour += 12;
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${m[3]}-${pad(month)}-${pad(Number(m[2]))}T${pad(hour)}:${m[5]}:00${tzOffset}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
