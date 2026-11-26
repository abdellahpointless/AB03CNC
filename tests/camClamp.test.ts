import { describe, expect, it } from 'vitest';
import { allowedCales, blankTop, jawMove, stepCale, underStock, whyNot } from '../src/lib/cam/clamp';

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

describe('the 0.5 mm method (you): the outline and holes whole in clamping 1, 0.5 mm under the part, then only facing', () => {
  // The outline 0.5 mm under the part and the jaws 0.5 mm under that: the jaws grip what is left of the stock under it.
  it('places the blank 5 mm under the part where the Z stock allows (a 4 mm grip), else 4 (3 mm), always 0.5 over it to face', () => {
    expect(blankTop(7)).toBe(2);
    expect(blankTop(6)).toBe(1);
    expect(blankTop(5.5)).toBe(0.5);
    expect(blankTop(5)).toBe(0.5);
    expect(blankTop(4.5)).toBe(0.5);
    // Under 4.5 mm (you): still 0.5 over it to face; what is left under it is too thin (refused, underStock).
    expect(blankTop(4.2)).toBe(0.5);
    expect(blankTop(3)).toBe(0.5);
  });

  it('wants 5 mm under the part (4 gripped), takes 4 (3 gripped) with a warning, and refuses less: a thicker blank', () => {
    expect(underStock(5)).toBeNull();
    expect(underStock(8)).toBeNull();
    expect(underStock(4.5)).toBe('lowGrip');
    expect(underStock(4)).toBe('lowGrip');
    expect(underStock(3.9)).toBe('tooThin');
    expect(underStock(0)).toBe('tooThin');
  });

  it('offers clamping 1 only parallels whose jaws stay under the outline (19 mm of stock, 5 under a 12 mm part)', () => {
    // Grip 3 to 4: the jaw tops 1 mm or more under the part's bottom.
    expect(allowedCales(19, -17, 12)).toEqual([42, 41]);
    expect(whyNot(41, 19, -17, 12)).toBeNull();
    expect(whyNot(42, 19, -17, 12)).toBeNull();
    expect(whyNot(40, 19, -17, 12)).toBe('outline');
    expect(whyNot(36, 19, -17, 12)).toBe('outline');
    expect(whyNot(43, 19, -17, 12)).toBe('tooShallow');
  });
});
