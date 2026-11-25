import { describe, expect, it } from 'vitest';
import { allowedCales, jawMove, stepCale, whyNot } from '../src/lib/cam/clamp';

describe('the clamping editor\'s moves (you, Beta 2)', () => {
  const cales = [42, 41, 40, 38, 36];
  it('steps through every parallel the shop has, from none, one at a time, and no further', () => {
    expect(stepCale(0, 1)).toBe(8);
    expect(stepCale(8, -1)).toBe(0);
    expect(stepCale(0, -1)).toBeNull();
    expect(stepCale(15, 1)).toBe(20);
    expect(stepCale(42, 1)).toBe(43);
    expect(stepCale(43, 1)).toBeNull();
    // From CAM AI's own (none chosen yet): its next one.
    expect(stepCale(null, 1)).toBeNull();
  });

  it('says why parallels cannot hold the part (19 mm of stock, its bottom 17 mm under the top)', () => {
    expect(whyNot(40, 19, -17)).toBeNull();
    expect(whyNot(43, 19, -17)).toBe('tooShallow');
    expect(whyNot(25, 19, -17)).toBe('allStock');
    expect(whyNot(28, 19, -17)).toBe('overTop');
    expect(allowedCales(19, -17).every((c) => whyNot(c, 19, -17) === null)).toBe(true);
  });

  it('slides the part only between the jaws, opens to the jaw\'s travel, and closing pushes the part back', () => {
    expect(jawMove({ open: 0, slide: 0 }, 'forward')).toBeNull();
    expect(jawMove({ open: 0, slide: 0 }, 'back')).toBeNull();
    expect(jawMove({ open: 0, slide: 0 }, 'close')).toBeNull();
    expect(jawMove({ open: 4, slide: -3 }, 'forward')).toEqual({ open: 4, slide: -4 });
    expect(jawMove({ open: 4, slide: -4 }, 'forward')).toBeNull();
    expect(jawMove({ open: 4, slide: -4 }, 'close')).toEqual({ open: 2, slide: -2 });
    expect(jawMove({ open: 34, slide: 0 }, 'open')).toBeNull();
    expect(jawMove({ open: 1, slide: -1 }, 'close')).toEqual({ open: 0, slide: 0 });
  });
});
