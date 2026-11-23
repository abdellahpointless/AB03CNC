import i18n from './index';
import enCam from './locales/en/cam';
import trCam from './locales/tr/cam';

/*
 * CAM AI's words (namespace "cam"). Only its private files import this (see ROOTS in
 * vite-private-chunks.ts): the shared app files, which every signed-in person gets, never name it.
 */
for (const [lang, bundle] of [['en', enCam], ['tr', trCam]] as const) {
  if (!i18n.hasResourceBundle(lang, 'cam')) i18n.addResourceBundle(lang, 'cam', bundle, true, true);
}

export default i18n;
