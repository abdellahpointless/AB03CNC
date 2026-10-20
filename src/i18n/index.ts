import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { pageLanguage } from '../lib/instance';
import type { Language } from '../regions';

import enCommon from './locales/en/common';
import enApp from './locales/en/app';
import enRemapper from './locales/en/remapper';
import enHistory from './locales/en/history';
import enPreventive from './locales/en/preventive';
import enParts from './locales/en/parts';
import enTools from './locales/en/tools';
import enData from './locales/en/data';
import enHub from './locales/en/hub';
import enMaster from './locales/en/master';
import enMachines from './locales/en/machines';

import trCommon from './locales/tr/common';
import trApp from './locales/tr/app';
import trRemapper from './locales/tr/remapper';
import trHistory from './locales/tr/history';
import trPreventive from './locales/tr/preventive';
import trParts from './locales/tr/parts';
import trTools from './locales/tr/tools';
import trData from './locales/tr/data';
import trHub from './locales/tr/hub';
import trMaster from './locales/tr/master';
import trMachines from './locales/tr/machines';

/*
 * Translations. Every country runs in its own language (Morocco: English, Türkiye: Turkish);
 * the language is fixed by the page address. English is also the fallback for any missing text.
 *
 * In components:   const { t } = useT('tools');   t('title')   t('common:actions.save')
 * Outside React:   import i18n from '../i18n';      i18n.t('tools:title')
 */

export const resources = {
  en: {
    common: enCommon,
    app: enApp,
    remapper: enRemapper,
    history: enHistory,
    preventive: enPreventive,
    parts: enParts,
    tools: enTools,
    data: enData,
    hub: enHub,
    master: enMaster,
    machines: enMachines,
  },
  tr: {
    common: trCommon,
    app: trApp,
    remapper: trRemapper,
    history: trHistory,
    preventive: trPreventive,
    parts: trParts,
    tools: trTools,
    data: trData,
    hub: trHub,
    master: trMaster,
    machines: trMachines,
  },
} as const;

export type Namespace = keyof (typeof resources)['en'];

void i18n.use(initReactI18next).init({
  resources,
  lng: pageLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(resources.en),
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
