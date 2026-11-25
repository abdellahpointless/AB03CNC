import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { heightPart } from './heightPart';

// Item 8: the designer picks which side is up in clamping 3 and on; the turn to it follows, the rest is CAM AI's.
describe('the sides of later clampings, as the designer picks them', () => {
  const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
  // Turned so the pocket faces X+, held first by its Y faces: a third clamping is needed for the pocket.
  const t = Array.from(plate);
  for (let k = 0; k < t.length; k += 3) [t[k], t[k + 2]] = [t[k + 2], -t[k]];
  const input = { tris: new Float32Array(t), material: 'ALU' as const, tools: [], brand: 'HAAS' as const, noNest: true, orient: { side: 'Y+', spin: false } };
  const sides = (r: ReturnType<typeof camProgram>) => r.setups.map((s) => s.side);

  it('takes the side asked for clamping 3, checked as any other', () => {
    const made = camProgram(input);
    expect(sides(made)).toEqual(['Y+', 'Y-', 'X+']);
    const r = camProgram({ ...input, sides: ['X+'] });
    expect(sides(r)).toEqual(['Y+', 'Y-', 'X+']);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);

  it('makes no clamping for a side with nothing to cut, and leaves out one already used or unknown; CAM AI covers the rest', () => {
    const empty = camProgram({ ...input, sides: ['X-'] });
    expect(sides(empty)).toEqual(['Y+', 'Y-', 'X+']);
    // Said, never silently: the designer picked it.
    expect(empty.notes).toContainEqual({ key: 'sideEmpty', side: 'X-' });
    const r = camProgram({ ...input, sides: ['Y+', 'Q9'] });
    expect(sides(r)).toEqual(['Y+', 'Y-', 'X+']);
    expect(r.notes.some((n) => n.key === 'sideEmpty')).toBe(false);
  }, 900_000);
});
