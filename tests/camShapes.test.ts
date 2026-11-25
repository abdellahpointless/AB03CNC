import { describe, expect, it } from 'vitest';
import { recognize } from '../src/lib/cam/shapes';
import { plateWithBlindHole, plateWithCounterbore, plateWithHoles, pocketWithHole } from './heightPart';

describe('the shapes of a part, named as the shop says them (you, Beta 2: item 4)', () => {
  it('a through hole once (it is seen from both faces), its Ø and depth; a pocket floor', () => {
    const shapes = recognize(pocketWithHole(60, 40, 12, [15, 10, 45, 30], 5, { c: [30, 20], d: 8 }));
    const through = shapes.filter((s) => s.kind === 'throughHole');
    expect(through).toHaveLength(1);
    expect(through[0].d).toBeCloseTo(8, 1);
    expect(through[0].count).toBe(1);
    expect(through[0].depth).toBeCloseTo(7, 1);
    expect(shapes.find((s) => s.kind === 'floor')?.depth).toBeCloseTo(5, 1);
  });

  it('holes alike counted together; a tap drill\'s Ø named as a likely thread (never programmed: taps are not used)', () => {
    const shapes = recognize(plateWithHoles(80, 40, 10, [{ c: [15, 20], d: 5 }, { c: [40, 20], d: 5 }, { c: [65, 20], d: 9 }]));
    const five = shapes.find((s) => s.kind === 'tapped');
    expect(five).toMatchObject({ count: 2, thread: 'M6' });
    expect(five?.d).toBeCloseTo(5, 1);
    expect(shapes.find((s) => s.kind === 'throughHole')?.d).toBeCloseTo(9, 1);
  });

  it('a blind hole, and a counterbore over a hole', () => {
    expect(recognize(plateWithBlindHole(40, 40, 15, { c: [20, 20], d: 7, depth: 8, point: false })).find((s) => s.kind === 'blindHole')).toMatchObject({ count: 1 });
    const cb = recognize(plateWithCounterbore(40, 40, 15, { c: [20, 20], d: 6.6, D: 11, depth: 6.4 }));
    const bore = cb.find((s) => s.kind === 'counterbore');
    expect(bore?.d).toBeCloseTo(11, 1);
    expect(bore?.depth).toBeCloseTo(6.4, 1);
    expect(cb.some((s) => (s.kind === 'throughHole' || s.kind === 'tapped') && Math.abs((s.d ?? 0) - 6.6) < 0.1)).toBe(true);
  });
});
