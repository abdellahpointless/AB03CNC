import type { Language } from '../src/regions';

/*
 * Server messages are written in English. For a country whose language is not English, the
 * message shown to the user is translated here, just before the response is sent. Exact
 * messages are looked up first, then patterns (for messages that contain a number or a name).
 * Anything not listed is sent in English.
 */

type Pattern = [RegExp, (...groups: string[]) => string];

const TR_EXACT: Record<string, string> = {};
const TR_PATTERNS: Pattern[] = [];

export function translateMessage(message: string, language: Language | undefined): string {
  if (!language || language === 'en' || !message) return message;
  if (language === 'tr') {
    const exact = TR_EXACT[message];
    if (exact) return exact;
    for (const [re, fn] of TR_PATTERNS) {
      const m = message.match(re);
      if (m) return fn(...m.slice(1));
    }
  }
  return message;
}

/** Filled by worker/i18n-tr.ts (kept separate so the dictionary can grow without touching the logic). */
export function registerTurkish(exact: Record<string, string>, patterns: Pattern[]): void {
  Object.assign(TR_EXACT, exact);
  TR_PATTERNS.push(...patterns);
}
