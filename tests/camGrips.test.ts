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
    // The 0.5 mm method (you): 4 mm under the part, gripped 3 under the outline (shown yellow on the page).
    [16.5, 42, 'only 4 mm under the part (0.5 over it): gripped 3 mm under the outline cut'],
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
    // A 40 x 30 x 4 plate on an 8.5 mm blank: 4 mm under it, the outline 0.5 under the part, the jaws 3 mm under that.
    const thin = heightPart(Array.from({ length: 30 }, () => Array.from({ length: 40 }, () => 4)));
    const r = camProgram({ ...base, tris: thin, raw: [44, 34, 8.5] });
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
    const r = camProgram({ ...base, tris: plate, raw: [56, 34, 16.5], second: 'X+' });
    const s = r.setups.find((x) => x.side === 'X+')!;
    expect(s.grip).toBeGreaterThanOrEqual(5);
    // The 0.5 mm method's clamping 1 cuts the outline free: on its edge the part then stands on the stock under it
    // alone, and the vise check locks it (too tall for that grip). The method turns it over instead.
    expect(s.physics.issues.map((i) => i.key)).toContain('tall');
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

  // A 30 x 30 x 6 flange with a b x b boss 10 high, turned over: the boss under the flange.
  const flangedBy = (b: number) => {
    const [lo, hi] = [(30 - b) / 2, (30 + b) / 2];
    return heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= lo && i < hi && j >= lo && j < hi ? 16 : 6))));
  };
  it('stays on the faces it holds at 3 mm: a boss too wide for parallels beside it is gripped no deeper than the boss, its size written', () => {
    // A 26 mm boss: no room under the flange for a parallel beside it, so the jaws hold the boss, 1 mm short of the flange.
    const r = camProgram({ ...base, tris: flangedBy(26), raw: [34, 34, 20.5] });
    const s = r.setups[1];
    expect(s.side).toBe('Z-');
    expect(s.notes.join(' ')).not.toMatch(/IN EP/);
    expect(s.grip).toBeGreaterThan(3);
    expect(s.grip).toBeLessThanOrEqual(9);
    expect(s.held[2] - s.held[0]).toBeCloseTo(26, 1);
    expect(s.held[3] - s.held[1]).toBeCloseTo(26, 1);
    expect(s.physics.issues.map((i) => i.key)).not.toContain('jawContact');
    expect(s.physics.issues.map((i) => i.key)).not.toContain('restContact');
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('rests the flange on the parallels by its step when the boss is narrow, never the boss in the jaws (you, a picture)', () => {
    // A 16 mm boss: the flange on 41 mm parallels 6 mm under Z0, the boss hanging between them, the jaws on the flange.
    const r = camProgram({ ...base, tris: flangedBy(16), raw: [34, 34, 20.5] });
    const s = r.setups[1];
    expect(s.side).toBe('Z-');
    expect(s.notes).toContain('41 MM UNTERLAGE IN EP 6 MM');
    expect(s.held[2] - s.held[0]).toBeCloseTo(30, 0);
    expect(s.held[3] - s.held[1]).toBeCloseTo(30, 0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check).toMatchObject({ collisions: 0, cales: 0 });
  }, 300_000);
});

describe('the blank', () => {
  it('stands lower on a thin Z stock, 4 mm under the part, so the outline still goes through in the first clamping', () => {
    // 5 mm on the thickness: 0.5 over the part, 4.5 under it (3 gripped, the outline 0.5 under the part, 0.5 over the jaws).
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 17] });
    expect(r.setups[0].notes[0]).toMatch(/\/Z\+ IN 0.5MM$/);
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

describe('the 0.5 mm method (you): always the outline whole in clamping 1', () => {
  const lowest = (r: ReturnType<typeof camProgram>) =>
    Math.min(...r.setups[0].ops.filter((o) => o.name.startsWith('FRAESEN')).flatMap((o) => o.lines.flatMap((l) => (/^G01.*Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : []))));

  it('refuses a blank with under 4 mm of Z stock for the jaws under the outline: a thicker blank is needed', () => {
    // 3 mm on the thickness: 0.5 cut under the part and 0.5 over the jaws leave them under 3 mm to grip.
    expect(() => camProgram({ ...base, tris: plate, raw: [44, 34, 15] })).toThrow(/thinBlank/);
    // Typed side by side: 3.5 mm under the part, however much over it.
    expect(() => camProgram({ ...base, tris: plate, margins: { lo: [2, 2, 3.5], hi: [2, 2, 3] } })).toThrow(/thinBlank/);
    // You: 0.5 mm over the part at the least, to face it: 4 mm on the thickness is refused, 4 under it or not.
    expect(() => camProgram({ ...base, tris: plate, raw: [44, 34, 16] })).toThrow(/thinBlank/);
    expect(() => camProgram({ ...base, tris: plate, margins: { lo: [2, 2, 5], hi: [2, 2, 0.2] } })).toThrow(/thinBlank/);
  });

  it('holds a blank with 4 mm under the part by 3 mm, the outline still 0.5 mm under the part', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16.5] });
    expect(r.setups[0].grip).toBe(3);
    expect(lowest(r)).toBeCloseTo(-12.5, 3);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('keeps clamping 1\'s jaws under the outline even where the vise check would want them deeper (a tall part)', () => {
    // 40 x 24 x 50, 5 mm under it: a 4 mm grip under a tall part; the retry for a better hold never climbs the wall.
    const tall = heightPart(Array.from({ length: 24 }, () => Array.from({ length: 40 }, () => 50)));
    const r = camProgram({ ...base, tris: tall, margins: { lo: [2, 2, 5], hi: [2, 2, 2] } });
    expect(r.setups[0].grip).toBeLessThanOrEqual(4);
    expect(lowest(r)).toBeCloseTo(-50.5, 3);
  }, 600_000);

  it('turns the simpler face up first only when asked (its fallback when the busiest face first fails the checks)', () => {
    const r = camProgram({ material: 'ALU', tools: [], brand: 'HAAS', noNest: true, tris: plate, raw: [44, 34, 19], simplerFirst: true });
    expect(r.setups[0].side).toBe('Z-');
    expect(lowest(r)).toBeCloseTo(-12.5, 3);
  }, 300_000);

  it('turns the busiest face up in clamping 1 when nobody chose (the pocket first, the plain face after the turn)', () => {
    const r = camProgram({ material: 'ALU', tools: [], brand: 'HAAS', noNest: true, tris: plate, raw: [44, 34, 19] });
    expect(r.setups[0].side).toBe('Z+');
    expect(r.setups[1].ops.filter((o) => o.kind === 'pocket' || o.kind === 'finish')).toEqual([]);
  }, 300_000);
});
