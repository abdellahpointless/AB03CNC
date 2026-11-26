import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { analyseProgram, DEFAULT_JAW_HEIGHT, reachAt } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { heightPart } from './heightPart';

// The owner: lower parallels in a later clamping showed the part sunk into the jaws. Held lower, the jaws come up to a
// wider part of it (here the flange) and grip that: where the view must draw them.
describe('where the jaws touch the part when its parallels change', () => {
  // A 40 x 30 flange 5 mm thick under a 20 x 14 body 15 mm tall; turned over, the body is held and the flange is on top.
  const part = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 8 && j < 22 ? 20 : 5))));
  const r = camProgram({ tris: part, material: 'ALU', tools: [], brand: 'HAAS', noNest: true, orient: { side: 'Z+', spin: false } });
  const program = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT });

  it('reads the hold as made, then the flange once the jaw tops come up to it', () => {
    const s = program.setups.find((x) => x.index > 0 && x.grip && x.stock && x.floorZ !== null && x.jawTopZ !== null)!;
    expect(s).toBeTruthy();
    const width = (g: { front: number | null; back: number | null } | null) => (g && g.front !== null && g.back !== null ? g.back - g.front : NaN);
    const asMade = reachAt(program, s, s.floorZ!);
    expect(asMade).not.toBeNull();
    expect(width(asMade)).toBeCloseTo(width(s.grip), 0);
    // Jaw tops 2 mm under the part's top: into the flange.
    const up = s.stock!.max[2] - 2 - s.jawTopZ!;
    expect(up).toBeGreaterThan(0);
    const higher = reachAt(program, { ...s, jawTopZ: s.jawTopZ! + up }, s.floorZ! + up);
    expect(width(higher)).toBeGreaterThan(width(asMade) + 5);
  });
});
