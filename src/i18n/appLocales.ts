import i18n from './index';
import { resources } from './resources';

/*
 * The rest of the app's translations, registered when the signed-in app loads (App.tsx,
 * MasterApp.tsx). Kept out of the public page so the app's wording is not handed out before
 * sign-in.
 */
for (const [lang, namespaces] of Object.entries(resources)) {
  for (const [ns, bundle] of Object.entries(namespaces)) {
    if (!i18n.hasResourceBundle(lang, ns)) i18n.addResourceBundle(lang, ns, bundle, true, true);
  }
}

export default i18n;
