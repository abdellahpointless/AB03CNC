import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { plateWithHoles } from './heightPart';
import { haasTools } from '../src/lib/defaultTools';

// An end mill goes straight down into material only in POM, FH and RESOPAL (2 mm in the last two). A hole an end mill
// only just fits leaves it a ring under 1 mm round, nothing to ramp along: it went straight down a whole pass.
describe('a hole an end mill only just fits', () => {
  it('is milled by a smaller mill that ramps round it, never by one going straight down into aluminium', () => {
    // 40 x 30 x 12, a Ø6.25 hole through it: no drill within 0.12 mm (Ø6.4 is the nearest); the Ø6 mill fits it by 0.25.
    const r = camProgram({ tris: plateWithHoles(40, 30, 12, [{ c: [20, 15], d: 6.25 }]), material: 'ALU', tools: haasTools, brand: 'HAAS', raw: [44, 34, 17], orient: { side: 'Z+', spin: false }, noNest: true });
    const s = r.setups[0];
    // In clamping 1 (centred frame: the hole at X0 Y0) no mill feeds straight down inside the hole deeper than the mills
    // have cut it so far (from the faced top, Z0): that is solid aluminium.
    let cut = 0;
    const down = s.ops
      .filter((o) => o.kind === 'pocket' || o.kind === 'finish')
      .flatMap((o) => {
        let [x, y, z] = [NaN, NaN, NaN];
        return o.lines.flatMap((l) => {
          [x, y, z] = ['X', 'Y', 'Z'].map((a, k) => Number(l.match(new RegExp(`${a}(-?[\\d.]+)`))?.[1] ?? [x, y, z][k]));
          if (!/^G0?1 /.test(l) || !(Math.hypot(x, y) < 3.2)) return [];
          const into = /^G0?1 Z/.test(l) && z < cut - 0.05;
          cut = Math.min(cut, z);
          return into ? [`${o.name} ${l}`] : [];
        });
      });
    expect(down).toEqual([]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 600_000);
});
