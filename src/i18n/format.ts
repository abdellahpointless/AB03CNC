import i18n from './index';

/*
 * Dates and numbers in the page's language: 20/10/2026 and 1 234,5 in Türkiye,
 * 20/10/2026 and 1,234.5 in Morocco (English, British format, as before).
 * Never use these for G-code: programs always use a dot and no thousands separator.
 */

export function locale(): string {
  return i18n.language === 'tr' ? 'tr-TR' : 'en-GB';
}

export function fmtDate(ts: number | string | Date | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '-';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString(locale());
}

export function fmtDateTime(ts: number | string | Date | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '-';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString(locale());
}

export function fmtTime(ts: number | string | Date | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '-';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function fmtNumber(n: number | null | undefined, maxFractionDigits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toLocaleString(locale(), { maximumFractionDigits: maxFractionDigits });
}

/** "2026-10" -> "October 2026" / "Ekim 2026" (or the short form "Oct 2026" / "Eki 2026"). */
export function fmtMonth(monthKey: string, short = false): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return d.toLocaleDateString(locale(), { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "3 min ago", "dün", ... */
export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  const t = i18n.t.bind(i18n);
  if (!ts) return t('common:time.never');
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return t('common:time.justNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('common:time.minutesAgo', { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('common:time.hoursAgo', { count: h });
  const d = Math.round(h / 24);
  return d === 1 ? t('common:time.yesterday') : t('common:time.daysAgo', { count: d });
}

/** A duration in seconds as "2 h 15 min" / "2 sa 15 dk". */
export function fmtDuration(seconds: number): string {
  const t = i18n.t.bind(i18n);
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h === 0) return t('common:units.minutesShort', { count: min });
  if (min === 0) return t('common:units.hoursShort', { count: h });
  return `${t('common:units.hoursShort', { count: h })} ${t('common:units.minutesShort', { count: min })}`;
}
