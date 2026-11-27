import i18n from '../i18n';

/*
 * A security log entry's detail in the page's language. The server records it in English
 * ("password", "ali (MACHINIST)", "toolpath on", "POST /tr/api/parts/review"); anything not known
 * here is shown as recorded.
 */

// Keys are built from the recorded text, so typed as one known key (as in toolExcelParse.ts).
const t = (key: string, options?: Record<string, unknown>) => i18n.t(`app:users.log.${key}` as 'app:users.log.detail.role', options ?? {});
const role = (r: string) => (i18n.exists(`common:role.${r}`) ? i18n.t(`common:role.${r}` as 'common:role.ADMIN') : r);

/** Recorded phrase -> its key under users.log.detail. */
const PHRASES: Record<string, string> = {
  password: 'password',
  totp: 'totp',
  'recovery code': 'recoveryCode',
  'account locked': 'locked',
  locked: 'locked',
  'IP throttled (unknown usernames)': 'ipThrottled',
  'password reset': 'passwordReset',
  'two-step sign-in reset': 'mfaReset',
  'toolpath beta on': 'toolpathBetaOn',
  'toolpath beta off': 'toolpathBetaOff',
};
/** The switches a country's admins know about; any other is left out of their log. */
const FEATURES = ['partTracking', 'preventive', 'shiftChecks', 'toolpath'];
/** The API area of an admin change (/api/<area>/...). */
const AREAS = ['fleet', 'machines', 'tools', 'parts', 'history', 'settings', 'admin', 'toolpath', 'alerts'];

function phrase(p: string): string {
  const r = /^role -> (\w+)$/.exec(p);
  if (r) return t('detail.role', { role: role(r[1]) });
  return PHRASES[p] ? t(`detail.${PHRASES[p]}`) : p;
}

export function auditDetail(action: string, detail: string | null): string {
  if (!detail) return '';
  switch (action) {
    case 'features_changed':
      return detail
        .split(', ')
        .map((c) => /^(\w+) (on|off)$/.exec(c))
        .filter((m): m is RegExpExecArray => !!m && FEATURES.includes(m[1]))
        .map((m) => t(m[2] === 'on' ? 'detail.featureOn' : 'detail.featureOff', { feature: t(`feature.${m[1]}`) }))
        .join(', ');
    case 'user_created': {
      const m = /^(.*) \((\w+)\)$/.exec(detail);
      return m ? `${m[1]} (${role(m[2])})` : detail;
    }
    case 'user_updated': {
      const i = detail.indexOf(': ');
      return i < 0 ? detail : `${detail.slice(0, i)}: ${detail.slice(i + 2).split(', ').map(phrase).join(', ')}`;
    }
    case 'admin_action':
    case 'admin_denied': {
      const area = /\/api\/([a-z-]+)/.exec(detail)?.[1];
      return area && AREAS.includes(area) ? t(`area.${area}`) : detail;
    }
    default:
      return phrase(detail);
  }
}
