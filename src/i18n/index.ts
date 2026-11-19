import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { pageLanguage } from '../lib/instance';
import type { Language } from '../regions';

import enCommon from './locales/en/common';
import enApp from './locales/en/app';
import enHub from './locales/en/hub';
import trCommon from './locales/tr/common';
import trApp from './locales/tr/app';
import trHub from './locales/tr/hub';
import type { resources } from './resources';

/*
 * Translations. Every country runs in its own language (Morocco: English, Türkiye: Turkish);
 * the language is fixed by the page address. English is also the fallback for any missing text.
 *
 * In components:   const { t } = useT('tools');   t('title')   t('common:actions.save')
 * Outside React:   import i18n from '../i18n';      i18n.t('tools:title')
 */

/** Loaded with the public page: the words of the country picker and the sign-in page. */
const publicResources = {
  en: { common: enCommon, app: enApp, hub: enHub },
  tr: { common: trCommon, app: trApp, hub: trHub },
};

export type { resources };
export type Namespace = keyof (typeof resources)['en'];

void i18n.use(initReactI18next).init({
  resources: publicResources,
  lng: pageLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(publicResources.en),
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  initAsync: false,
});

if (typeof document !== 'undefined') document.documentElement.lang = i18n.language;

/** Translations of one namespace, plus `common:` keys (shared words) in the same `t`. */
export function useT<N extends Namespace>(ns: N) {
  return useTranslation([ns, 'common'] as const);
}

export function currentLanguage(): Language {
  return (i18n.language === 'tr' ? 'tr' : 'en') as Language;
}

export async function setLanguage(lang: Language): Promise<void> {
  await i18n.changeLanguage(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export default i18n;
