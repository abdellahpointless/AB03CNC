import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { columnPart, heightPart } from './heightPart';

// How CAM AI holds the part in the vise, against the engineers' programs (Phase 6: their parallels, not the tallest ones).

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
const base = { material: 'ALU' as const, tools: [], brand: 'HAAS', noNest: true, orient: { side: 'Z+', spin: false } };

describe('the first clamping', () => {
  it.each([
    // You: the outline whole in the first clamping, 0.5 mm under the part, gripped as deep as that allows.
    [22, 38, 'stock enough under the part for the outside to go through: gripped 7 of its 8 mm, 1 mm under the outline'],
    [16, 40, 'only 2 mm under the part: the jaws hold the foot of its wall, the next clamping cuts the outside left there'],
  ])('stands on its parallels as deep as the outside allows: raw %i high, on %i mm, %s', (rawH, cale) => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, rawH] });
    expect(r.setups[0].cale).toBe(cale);
    expect(r.setups[0].grip).toBe(45 - cale);
    expect(r.setups[0].notes).toContain(`${cale} MM UNTERLAGE`);
    expect(r.setups).toHaveLength(2);
    expect(r.setups.every((s) => s.physics.ok)).toBe(true);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('cuts the outside 0.5 mm under the part, or stops it clear above, never level with its bottom (a review finding)', () => {
    // No blank given: 7.5 mm on the thickness, 2 on top, 5.5 under the part. A 5 mm grip would stop the outside
    // exactly at the part's bottom, which the face mill cuts after the turn: no overlap.
    const r = camProgram({ ...base, tris: plate });
    const lowest = Math.min(...r.setups[0].ops.filter((o) => o.name.startsWith('FRAESEN')).flatMap((o) => o.lines.flatMap((l) => (/^G01.*Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : []))));
    expect(lowest).toBeLessThanOrEqual(-12.5 + 1e-6);
    expect(r.setups[0].grip).toBeLessThanOrEqual(4);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('grips a part too thin for 5 mm as little as holds (3 mm)', () => {
    // A 40 x 30 x 4 plate on a 6 mm blank: 5 mm would leave the outside between the clampings' jaws uncut.
    const thin = heightPart(Array.from({ length: 30 }, () => Array.from({ length: 40 }, () => 4)));
    const r = camProgram({ ...base, tris: thin, raw: [44, 34, 6] });
    expect(r.setups[0].grip).toBe(3);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);
});

describe('a later clamping', () => {
  const jawTops = (r: ReturnType<typeof camProgram>) => analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT }).setups.map((s) => s.jawTopZ!);

  it('grips as deep as its own cuts beside the held faces allow, 1 mm under them (the shop: 101 of 160 later clampings), not 3 mm', () => {
    // Raw 22: 5 mm under the part, gripped 5 mm in the first clamping, whose outside stops 0.5 mm over the part's bottom.
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 22] });
    expect(r.setups).toHaveLength(2);
    expect(r.setups[1].grip).toBeGreaterThanOrEqual(7);
    // The jaws 1 mm under the 0.5 mm of outside the first clamping left, and 1.3 mm under the top face (room for a graver).
    expect(jawTops(r)[1]).toBeLessThanOrEqual(-1.3);
    expect(r.setups.every((s) => s.physics.ok)).toBe(true);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('grips into the stock it stands on: what is under the part is never cut there (a review finding)', () => {
    // On an edge (X+ up) with 8 mm of stock under the part: gripped in it, not 3 mm.
    const r = camProgram({ ...base, tris: plate, raw: [56, 34, 16], second: 'X+' });
    const s = r.setups.find((x) => x.side === 'X+')!;
    expect(s.grip).toBeGreaterThanOrEqual(5);
    expect(s.physics.ok).toBe(true);
  }, 300_000);

  it.each([
    ['X+', (i: number) => i >= 34],
    ['X-', (i: number) => i < 6],
  ])('grips deep on the faces it holds when only an end changes (a step at the %s end), placed where the program says', (_end, step) => {
    // A 40 x 30 x 20 block with a 6 mm step down at one X end: turned over, the step is at the bottom of an end (the
    // stop's or the far one), the held Y faces the same all the way up. You: hold the part as deep as its cuts allow.
    const stepped = heightPart(Array.from({ length: 30 }, () => Array.from({ length: 40 }, (_, i) => (step(i) ? 14 : 20))));
    const r = camProgram({ ...base, tris: stepped, raw: [44, 34, 27] });
    const s = r.setups.find((x) => x.side === 'Z-')!;
    expect(s.grip).toBeGreaterThanOrEqual(10);
    expect(s.physics.ok).toBe(true);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('grips deep where the stock still to cut lies far from the jaws and the stop (a slot from the free end, mid-width)', () => {
    // A 40 x 50 x 20 block with a slot 10 wide, 15 deep from its bottom, running out of its X+ end, mid-width: turned
    // over, the slot's stock is 20 mm from the jaws and 30 from the stop, no tool there meets either. You: hold the part
    // as deep as its cuts allow (the study's clamping 2 gripped 9 mm for a strip like it at its free end).
    const lo = Array.from({ length: 50 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 30 && j >= 20 && j < 30 ? 15 : 0)));
    const hi = Array.from({ length: 50 }, () => Array.from({ length: 40 }, () => 20));
    const r = camProgram({ ...base, tris: columnPart(lo, hi), raw: [44, 54, 27] });
    const s = r.setups.find((x) => x.side === 'Z-')!;
    expect(s.grip).toBeGreaterThanOrEqual(10);
    expect(s.physics.ok).toBe(true);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
  }, 300_000);

  it('stays on the faces it holds at 3 mm: a boss is gripped no deeper than the boss, its size written', () => {
    // A 30 x 30 x 6 flange with a 16 x 16 boss 10 high: turned over, the jaws hold the boss, 1 mm short of the flange.
    const flanged = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 7 && i < 23 && j >= 7 && j < 23 ? 16 : 6))));
    const r = camProgram({ ...base, tris: flanged, raw: [34, 34, 20] });
    const s = r.setups[1];
    expect(s.side).toBe('Z-');
    expect(s.grip).toBeGreaterThan(3);
    expect(s.grip).toBeLessThanOrEqual(9);
    expect(s.held[2] - s.held[0]).toBeCloseTo(16, 1);
    expect(s.held[3] - s.held[1]).toBeCloseTo(16, 1);
    expect(s.physics.issues.map((i) => i.key)).not.toContain('jawContact');
    expect(s.physics.issues.map((i) => i.key)).not.toContain('restContact');
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);
});

describe('the blank', () => {
  it('stands lower on a thin Z stock, 4 mm under the part, so the outline still goes through in the first clamping', () => {
    // 5 mm on the thickness: 1 over the part, 4 under it (3 gripped, the outline 0.5 under the part, 0.5 over the jaws).
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 17] });
    expect(r.setups[0].notes[0]).toMatch(/\/Z\+ IN 1MM$/);
    expect(r.setups[0].grip).toBe(3);
    const lowest = Math.min(...r.setups[0].ops.filter((o) => o.name.startsWith('FRAESEN')).flatMap((o) => o.lines.flatMap((l) => (/^G01.*Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : []))));
    expect(lowest).toBeCloseTo(-12.5, 3);
    expect(r.setups[1].ops.filter((o) => o.kind === 'pocket' || o.kind === 'finish')).toEqual([]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('stands 2 mm over the part on the first clamping’s side, the rest under it (the shop faces 2-3 mm): the outside goes through there', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 22] });
    expect(r.setups[0].notes[0]).toMatch(/\/Z\+ IN 2MM$/);
    // The other 8 mm under the part: faced off after the turn.
    expect(r.setups[1].notes[0]).toMatch(/\/Z\+ IN 8MM$/);
    // Gripped 7 mm of the 8 under the part, the outside cut 0.5 mm under its bottom, 0.5 mm over the jaws.
    const lowest = Math.min(...r.setups[0].ops.filter((o) => o.name.startsWith('FRAESEN')).flatMap((o) => o.lines.flatMap((l) => (/^G01.*Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : []))));
    expect(lowest).toBeCloseTo(-12.5, 3);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // Where it was planned, for the 3D view (model frame, centred on the part's box): 2 mm over the part's top.
    expect(r.blank.hi.map((v) => Math.round(v * 1000) / 1000)).toEqual([22, 17, 8]);
    expect(r.blank.lo.map((v) => Math.round(v * 1000) / 1000)).toEqual([-22, -17, -14]);
  }, 300_000);

  it('says where it was when CAM AI planned it centred (its fallback), for the 3D view to draw it there', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 22], centred: true });
    expect(r.blank.hi.map((v) => Math.round(v * 1000) / 1000)).toEqual([22, 17, 11]);
    expect(r.blank.lo.map((v) => Math.round(v * 1000) / 1000)).toEqual([-22, -17, -11]);
  }, 300_000);
});
