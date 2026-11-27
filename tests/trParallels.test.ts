import { describe, expect, it } from 'vitest';
import { resources } from '../src/i18n/resources';
import trCam from '../src/i18n/locales/tr/cam';
import { RELEASES } from '../src/lib/whatsNew';
import { CAM_RELEASES } from '../src/lib/cam/news';

// Turkish calls the parallels "paralel"; "kale" (the French "cale") means castle in Turkish.
const texts = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : []);

describe('Turkish word for the parallels', () => {
  it('is never "kale"', () => {
    const all = [...texts(resources.tr), ...texts(trCam), ...[...RELEASES, ...CAM_RELEASES].flatMap((r) => texts(r.tr))];
    expect(all.length).toBeGreaterThan(1000);
    expect(all.filter((s) => /(^|[^\p{L}])kale(?!m)/iu.test(s))).toEqual([]);
  });
});
