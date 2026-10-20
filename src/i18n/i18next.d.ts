import 'i18next';
import type { resources } from './index';

// Typed keys: t('tools:title') is checked against the English resources at compile time.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['en'];
  }
}
