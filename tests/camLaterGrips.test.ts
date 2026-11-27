import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { camProgram } from '../src/lib/cam/program';
import { haasTools } from '../src/lib/defaultTools';

// Later clampings' grips (you, 2026-11-27), on the test parts of tools/test-part/make_step_parts.py, brass on HAAS-1.
const plan = async (name: string, side: string, raw: [number, number, number]) => {
  const { tris, faces } = await stepMesh(new Uint8Array(readFileSync(`tests/models/step-${name}.step`)));
  return camProgram({ material: 'MS', tools: haasTools, brand: 'HAAS', orient: { side, spin: false }, tris, faces, raw });
};

describe('a later clamping', () => {
  it('grips under the stock it still cuts beside the part, measured from the faces it holds (the foot down first)', async () => {
    // Body 30 x 24 x 10 on a foot 16 x 12 x 8: turned over, the stock round the foot is cut down to the body. The waste on
    // top (34 x 28) is wider than the body the jaws hold: from it, that stock looked out of the jaws' way, and they gripped
    // 15 mm, over it (4 clampings, a nest).
    const r = await plan('foot-under-body', 'Z+', [34, 28, 26.5]);
    expect(r.setups.map((s) => s.side)).toEqual(['Z+', 'Z-']);
    // Its jaw tops 1 mm under the foot's stock (8 mm over the body's 10): the body gripped 9 mm at the most.
    expect(r.setups[1].grip).toBeLessThanOrEqual(9.05);
    expect(r.setups[1].nest).toBeUndefined();
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.notes.some((n) => n.key === 'jawWall')).toBe(false);
  }, 300_000);

  it('turns a quarter about Z when the face it would hold is broken into teeth by a counterbore, the jaws on the other pair', async () => {
    // Y+ first; turned over, the jaws would hold the Z faces, one of them a 4 mm flat the counterbore broke into two
    // 0.06 mm teeth (before: in the POM nest). Turned a quarter, they hold the X faces, 20 apart.
    const r = await plan('teeth', 'Y+', [24, 18.5, 20]);
    expect(r.setups.map((s) => s.side)).toEqual(['Y+', 'Y-']);
    const s = r.setups[1];
    expect(s.nest).toBeUndefined();
    expect(s.notes.join(' ')).toContain('90 GRAD UM Z');
    expect(s.held[3] - s.held[1]).toBeCloseTo(20, 1);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
  }, 300_000);
});
