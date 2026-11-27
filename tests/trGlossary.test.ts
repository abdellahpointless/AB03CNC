import { describe, expect, it } from 'vitest';
import { resources } from '../src/i18n/resources';
import trCam from '../src/i18n/locales/tr/cam';
import { RELEASES } from '../src/lib/whatsNew';
import { CAM_RELEASES } from '../src/lib/cam/news';

// One Turkish word per thing: tezgah, şifre, Takım eşleştirici, 3B, radyüslü.
const texts = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : []);
const OTHER_WORDS = /(^|[^\p{L}])(makine|parola|eşleyici|remapper|radyus)|3D(?!-MODELL)/iu;

describe('Turkish glossary', () => {
  it('uses the agreed word for each thing', () => {
    const all = [...texts(resources.tr), ...texts(trCam), ...[...RELEASES, ...CAM_RELEASES].flatMap((r) => texts(r.tr))];
    expect(all.length).toBeGreaterThan(1000);
    expect(all.filter((s) => OTHER_WORDS.test(s))).toEqual([]);
  });
});
