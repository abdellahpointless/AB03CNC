/*
 * Every translation of the app. Only the sign-in page's words (common, app, hub) are loaded with
 * the public page (see ./index.ts); the rest is registered by ./appLocales.ts, which only the
 * signed-in app loads, so the app's wording is not handed out before sign-in.
 */
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

