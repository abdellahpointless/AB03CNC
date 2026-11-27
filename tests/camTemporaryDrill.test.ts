import { describe, expect, it } from 'vitest';
import { camProgram, editProgram } from '../src/lib/cam/program';
import { LIBRARY } from '../src/lib/cam/tools';
import type { ToolDb } from '../src/lib/cam/toolDb';
import { plateWithHoles } from './heightPart';

// Item 15: no drill of the hole's Ø and no end mill small enough to mill it: the nearest smaller drill stands in,
// flagged temporary, and the right drill stays listed as missing.
describe('a hole with neither its drill nor an end mill that fits', () => {
  const tris = plateWithHoles(30, 20, 8, [{ c: [10, 10], d: 3 }, { c: [20, 10], d: 3 }]);
  const input = { tris, material: 'ALU' as const, tools: [], brand: 'HAAS' as const, noNest: true, orient: { side: 'Z+', spin: false }, margins: { lo: [3, 2, 6.5] as [number, number, number], hi: [3, 2, 2] as [number, number, number] } };
  const off = LIBRARY.ALU.filter((t) => (t.type === 'SB' && Math.abs(t.d - 3) <= 0.12) || (t.type !== 'SB' && t.d <= 2.8));
  const toolDb: ToolDb = { ALU: Object.fromEntries(off.map((t) => [t.code, { removed: true as const }])) };

  it('drills it with the nearest smaller drill, says so once, and still lists the right one', () => {
    const r = camProgram({ ...input, toolDb });
    const temp = r.notes.filter((n) => n.key === 'temporaryTool');
    expect(temp).toHaveLength(1);
    expect(temp[0]).toMatchObject({ setup: 1, d: 3, used: 2.5 });
    expect(r.code).toMatch(/SB_02\.50/);
    // Listed as drilled smaller for now, not as left out (a review found the left-out words).
    expect(r.missing.find((m) => m.category === 'foret' && m.diameter === 3)?.why).toMatchObject({ key: 'holeSmaller', used: 2.5 });
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  // The owner: the stand-in may be smaller (down to 80 %); the designer takes its operation down by hand where needed.
  it('its operation can be taken down by hand, checked again; too far is locked', () => {
    const r = camProgram({ ...input, toolDb });
    const s = r.setups.findIndex((x) => x.ops.some((o) => /SB_02\.50/.test(o.tool.code)));
    const k = r.setups[s].ops.findIndex((o) => /SB_02\.50/.test(o.tool.code));
    const op = r.setups[s].ops[k];
    const key = op.key ?? `${r.setups[s].side}|${op.name}|${op.tool.code}|${k}`;
    const depth = (code: string) => Math.min(...[...code.matchAll(/G8[13][^\n]*Z(-?[\d.]+)/g)].map((m) => Number(m[1])));
    const down = editProgram({ ...input, toolDb }, r, { [key]: { deeper: 0.4 } });
    expect(depth(down.code)).toBeCloseTo(depth(r.code) - 0.4, 3);
    expect(down.check.collisions).toBe(r.check.collisions);
    // 45 mm more: past its 50 mm length (the holder into the part) and onto the vise floor between the parallels: locked.
    const far = editProgram({ ...input, toolDb }, r, { [key]: { deeper: 45 } });
    expect(far.check.holders).toBeGreaterThan(0);
    expect(far.notes.some((n) => n.key === 'floorHit')).toBe(true);
  }, 300_000);

  it('uses its own drill when the shop has it: nothing temporary', () => {
    const r = camProgram(input);
    expect(r.notes.some((n) => n.key === 'temporaryTool')).toBe(false);
  }, 300_000);
});
