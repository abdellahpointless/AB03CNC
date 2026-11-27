import { describe, expect, it } from 'vitest';
import enRemapper from '../src/i18n/locales/en/remapper';
import enCam from '../src/i18n/locales/en/cam';

// The 3D screens and CAM say "parallels"; "cales" stays the name of the Cales box (explained once).
const texts = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : []);

describe('English word for the parallels', () => {
  it('is "parallels" in the remapper and CAM texts', () => {
    const all = [...texts(enRemapper), ...texts(enCam)].map((s) => s.replace(/\{\{cale\}\}|cales box|\(cales\)/gi, ''));
    expect(all.filter((s) => /\bcales?\b/i.test(s))).toEqual([]);
  });
});
