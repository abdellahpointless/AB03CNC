import i18n from '../i18n';

// Baseline time constants in seconds based on machining practice:
// Manual code editing / tool modification: ~5 to 6 minutes (avg 5.5 min = 330 seconds)
// CNC Process Pro app: ~30 seconds to 1 minute (avg 45 seconds)
// Net time won per extraction: 330s - 45s = 285s (~4m 45s)
// The live value is an admin setting stored on the server (see /api/analytics).
export const DEFAULT_SAVED_SECONDS_PER_EXTRACTION = 285;

export function formatTimeWon(totalSeconds: number): {
  formatted: string;
  shortText: string;
  clockTime: string;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');
  // Units in the page's language: "4m 45s" in English, "4 dk 45 sn" in Turkish.
  const d = (n: number | string) => i18n.t('app:timeWon.days', { n });
  const h = (n: number | string) => i18n.t('app:timeWon.hours', { n });
  const m = (n: number | string) => i18n.t('app:timeWon.minutes', { n });
  const sec = (n: number | string) => i18n.t('app:timeWon.seconds', { n });

  let formatted = '';
  if (days > 0) {
    formatted = `${d(days)} ${h(hours)} ${m(minutes)}`;
  } else if (hours > 0) {
    formatted = `${h(hours)} ${m(pad(minutes))} ${sec(pad(seconds))}`;
  } else if (minutes > 0) {
    formatted = `${m(minutes)} ${sec(pad(seconds))}`;
  } else {
    formatted = sec(seconds);
  }

  let shortText = '';
  if (days > 0) {
    shortText = `${d(days)} ${h(hours)}`;
  } else if (hours > 0) {
    shortText = `${h(hours)} ${m(minutes)}`;
  } else if (minutes > 0) {
    shortText = m(minutes);
  } else {
    shortText = sec(seconds);
  }

  const clockTime = `${days > 0 ? `${d(days)} ` : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  return { formatted, shortText, clockTime, days, hours, minutes, seconds };
}
