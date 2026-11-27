import { describe, expect, it } from 'vitest';
import { allowedCales, blankTop, firstPick, jawGap, jawMove, refusedHold, stepCale, underNeed, underStock, whyNot } from '../src/lib/cam/clamp';

describe('a later clamping\'s hold the program made refused (its note says so)', () => {
  it('matches the note of its kind for the value asked, a step within 0.05 mm', () => {
    expect(refusedHold({ key: 'stepRefused', setup: 2, cale: 7 }, { step: 7 })).toBe(true);
    expect(refusedHold({ key: 'stepHold', setup: 2, cale: 4.5 }, { step: 4.52 })).toBe(true);
    expect(refusedHold({ key: 'jawRefused', setup: 2, cale: 6 }, { jaw: 6 })).toBe(true);
    expect(refusedHold({ key: 'clampRefused', setup: 2, cale: 30 }, { cale: 30 })).toBe(true);
    // Another value asked since (not made yet), or a note of another kind: not refused.
    expect(refusedHold({ key: 'stepRefused', setup: 2, cale: 7 }, { step: 6 })).toBe(false);
    expect(refusedHold({ key: 'clampRefused', setup: 2, cale: 30 }, { step: 30 })).toBe(false);
    expect(refusedHold({ key: 'sideEmpty', setup: 2 }, { cale: 30 })).toBe(false);
  });
});

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
  // The outline 0.5 mm under the part, the jaw tops the gap (1 mm; 1 to 1.5 in the settings) under that: the jaws grip
  // what is left of the stock under it, 5 mm wanted, 3 at the least.
  it('keeps the gap within 1 to 1.5 mm, 1 when not given', () => {
    expect(jawGap()).toBe(1);
    expect(jawGap(1.25)).toBe(1.25);
    expect(jawGap(0.5)).toBe(1);
    expect(jawGap(2)).toBe(1.5);
    expect(jawGap(NaN)).toBe(1);
    expect(underNeed()).toBe(4.5);
    expect(underNeed(1, 5)).toBe(6.5);
    expect(underNeed(1.5)).toBe(5);
  });

  it('places the blank 6.5 mm under the part where the Z stock allows (a 5 mm grip), else 0.5 over it to face and the rest under', () => {
    expect(blankTop(9)).toBe(2);
    expect(blankTop(8.5)).toBe(2);
    expect(blankTop(7.5)).toBe(1);
    expect(blankTop(7)).toBe(0.5);
    expect(blankTop(6)).toBe(0.5);
    expect(blankTop(5)).toBe(0.5);
    // Under 5 mm (you): still 0.5 over it to face; what is left under it is too thin (refused, underStock).
    expect(blankTop(4.5)).toBe(0.5);
    expect(blankTop(3)).toBe(0.5);
    // A 1.5 mm gap: 7 mm under the part for the 5 mm grip.
    expect(blankTop(8.5, 1.5)).toBe(1.5);
    expect(blankTop(7.5, 1.5)).toBe(0.5);
  });

  it('wants 6.5 mm under the part (5 gripped), takes 4.5 (3 gripped) with a warning, and refuses less: a thicker blank', () => {
    expect(underStock(6.5)).toBeNull();
    expect(underStock(8)).toBeNull();
    expect(underStock(6)).toBe('lowGrip');
    expect(underStock(4.5)).toBe('lowGrip');
    expect(underStock(4.4)).toBe('tooThin');
    expect(underStock(4)).toBe('tooThin');
    expect(underStock(0)).toBe('tooThin');
    // A 1.5 mm gap: 5 mm at the least, 7 wanted.
    expect(underStock(4.5, 1.5)).toBe('tooThin');
    expect(underStock(5, 1.5)).toBe('lowGrip');
    expect(underStock(6.5, 1.5)).toBe('lowGrip');
    expect(underStock(7, 1.5)).toBeNull();
  });

  it('offers clamping 1 only parallels whose jaw tops stay the gap under the outline cut', () => {
    // 19 mm of stock, 5 under a 12 mm part: the jaw tops 1.5 mm or more under the part's bottom, so a 3 mm grip only.
    expect(allowedCales(19, -17, 12)).toEqual([42]);
    expect(whyNot(42, 19, -17, 12)).toBeNull();
    expect(whyNot(41, 19, -17, 12)).toBe('outline');
    expect(whyNot(36, 19, -17, 12)).toBe('outline');
    expect(whyNot(43, 19, -17, 12)).toBe('tooShallow');
    // 6.5 under it: up to 5 gripped, CAM AI's own the deepest (40 mm parallels); with a 1.5 mm gap up to 4 (41).
    expect(allowedCales(20.5, -18.5, 12)).toEqual([42, 41, 40]);
    expect(firstPick(20.5, -18.5, 12)).toEqual({ cale: 40, grip: 5 });
    expect(allowedCales(20.5, -18.5, 12, 1.5)).toEqual([42, 41]);
    expect(whyNot(40, 20.5, -18.5, 12, 1.5)).toBe('outline');
    expect(firstPick(20.5, -18.5, 12, 1.5)).toEqual({ cale: 41, grip: 4 });
    // Never under 1 mm, whatever is asked.
    expect(allowedCales(20.5, -18.5, 12, 0.5)).toEqual([42, 41, 40]);
  });
});
