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

  let formatted = '';
  if (days > 0) {
    formatted = `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    formatted = `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  } else if (minutes > 0) {
    formatted = `${minutes}m ${pad(seconds)}s`;
  } else {
    formatted = `${seconds}s`;
  }

  let shortText = '';
  if (days > 0) {
    shortText = `${days}d ${hours}h`;
  } else if (hours > 0) {
    shortText = `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    shortText = `${minutes}m`;
  } else {
    shortText = `${seconds}s`;
  }

  const clockTime = `${days > 0 ? `${days}d ` : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

  return { formatted, shortText, clockTime, days, hours, minutes, seconds };
}
