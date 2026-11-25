import { describe, expect, it } from 'vitest';
import { jawMove, stepCale } from '../src/lib/cam/clamp';

describe('the clamping editor\'s moves (you, Beta 2)', () => {
  const cales = [42, 41, 40, 38, 36];
  it('steps the parallels from none through the allowed heights, one at a time, and no further', () => {
    expect(stepCale(cales, 0, 1)).toBe(36);
    expect(stepCale(cales, 36, -1)).toBe(0);
    expect(stepCale(cales, 0, -1)).toBeNull();
    expect(stepCale(cales, 40, 1)).toBe(41);
    expect(stepCale(cales, 42, 1)).toBeNull();
    // A height not allowed (CAM AI's own outside the list): from the tallest.
    expect(stepCale(cales, 25, -1)).toBe(42);
    expect(stepCale([], 40, 1)).toBeNull();
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
