import 'i18next';
import type { resources } from './resources';
import type enCam from './locales/en/cam';

// Typed keys: t('tools:title') is checked against the English resources at compile time. "cam" is
// registered apart, by its private files only (camLocales.ts).
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['en'] & { cam: typeof enCam };
  }
}
