import { describe, expect, it } from 'vitest';
import { layouts, toModelAxes } from '../src/lib/cam/layouts';
import { camProgram, checkProgram } from '../src/lib/cam/program';
import { analyseProgram, DEFAULT_JAW_HEIGHT, STOP_PLATE } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import type { Tool } from '../src/types';
import { columnPart, heightPart } from './heightPart';

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top; a 300x60x20 bar.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
const bar = heightPart(Array.from({ length: 60 }, () => Array.from({ length: 300 }, () => 20)));

describe('how the part lies in the vise', () => {
  it('lists all 12 ways, best first: the pocket side up, low and flat', () => {
    const all = layouts(plate);
    expect(all).toHaveLength(12);
    expect(all[0]).toMatchObject({ side: 'Z+', fits: true, twoVises: false });
    expect(all[0].size[2]).toBeCloseTo(12, 5);
    expect(all[0].topShare).toBeGreaterThan(all.find((l) => l.side === 'Z-')!.topShare);
  });

  it('turns a long bar so one vise holds it (300 between the jaws, 60 along them)', () => {
    const best = layouts(bar)[0];
    expect(best.twoVises).toBe(false);
    expect(best.size.map((v) => Math.round(v))).toEqual([60, 300, 20]);
  });

  it('excess given along the vise goes back on the model axes', () => {
    const turned = layouts(plate).find((l) => l.side === 'Z+' && l.spin)!;
    // Turned a quarter: the vise X is the model Y.
    expect(toModelAxes(turned.R, [1, 2, 3])).toEqual([2, 1, 3]);
  });

  it('the planner follows the chosen layout', () => {
    const tools: Tool[] = [{ id: 'f', number: 1, category: 'tourteau', description: '', diameter: 40, length: 30 }];
    const r = camProgram({ tris: plate, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: true } });
    // Turned: the 34 side lies along the jaws (X), the 44 between them (Y).
    expect(r.code).toMatch(/M0 \(TEIL MIT 34 IN X UND 44 IN Y EINSPANNEN/);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 180_000);
});

describe('where a clamping puts the part', () => {
  it('puts the faces the vise holds at the stop and the fixed jaw, and writes their size, in every clamping (gap P1)', () => {
    // After the first clamping has cut the outside, the jaws hold the finished faces, not the raw stock above them.
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    const an = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT });
    expect(an.setups.length).toBeGreaterThanOrEqual(2);
    an.setups.forEach((s, k) => {
      expect(s.grip && s.clampBox, `clamping ${k + 1}`).toBeTruthy();
      // The app's reader finds the held faces where the program puts the part (straight walls: within 0.1 mm).
      expect(Math.abs(s.grip!.stop - s.clampBox!.min[0]), `clamping ${k + 1} at the stop`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(s.clampBox!.max[1] - s.grip!.back), `clamping ${k + 1} at the fixed jaw`).toBeLessThanOrEqual(0.1);
    });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.misplaced).toBe(0);
    // The size written is the part's own after the turn (40 x 30), not the simulation grid's outline of it,
    // which stands up to a cell and a half further out (40.36 x 30.35 here, 0.6 mm a side on a 300 mm plate).
    const turned = r.code.match(/DREHEN\/(\d+(?:\.\d+)?) IN X UND (\d+(?:\.\d+)?) IN Y/)!;
    expect(Number(turned[1])).toBeCloseTo(40, 1);
    expect(Number(turned[2])).toBeCloseTo(30, 1);
    // Where G52 puts it (the gaps above compare the written size with the faces, both placed by G52, so
    // they cannot see it): the 40 x 30 held faces at the stop (X-50) and at the fixed jaw (Y50).
    const g52 = [...r.code.matchAll(/G52 X(-?[\d.]+) Y(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(g52[0]).toEqual([-28, 33]);
    expect(g52[1][0]).toBeCloseTo(-30, 2);
    expect(g52[1][1]).toBeCloseTo(35, 2);
    // The second clamping written with the whole stock's size (44 x 34), as CAM AI wrote it before: the
    // vise holds 40 x 30 there, the part would sit 2 mm off; the check counts it, and that locks the program.
    const wrong = r.code.replace(/(DREHEN\/)(\d+(?:\.\d+)?) IN X UND (\d+(?:\.\d+)?) IN Y/, (_m, pre: string, x: string, y: string) => `${pre}${Number(x) + 4} IN X UND ${Number(y) + 4} IN Y`);
    expect(wrong).not.toBe(r.code);
    expect(checkProgram(plate, wrong, 'HAAS', undefined, r.pose).misplaced).toBeGreaterThan(0);
  }, 300_000);

  it('places a part held by a band off its middle where the program puts it (P1: the boss the jaws grip after the turn)', () => {
    // A 30 x 30 x 8 plate with a 12 x 24 boss 6 high off the middle in X: turned over, the jaws hold the boss only.
    const boss = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 4 && i < 16 && j >= 3 && j < 27 ? 14 : 8))));
    const r = camProgram({ tris: boss, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 34, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    const an = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT });
    expect(an.setups.length).toBeGreaterThanOrEqual(2);
    // The held band really is off the stock's middle (else this tests nothing).
    expect(r.setups.some((s) => Math.abs(s.held[0] + s.held[2] - s.box[0] - s.box[2]) / 2 > 2)).toBe(true);
    an.setups.forEach((s, k) => {
      expect(s.grip && s.clampBox, `clamping ${k + 1}`).toBeTruthy();
      expect(Math.abs(s.grip!.stop - s.clampBox!.min[0]), `clamping ${k + 1} at the stop`).toBeLessThanOrEqual(0.3);
      expect(Math.abs(s.clampBox!.max[1] - s.grip!.back), `clamping ${k + 1} at the fixed jaw`).toBeLessThanOrEqual(0.3);
    });
    expect(r.check.misplaced).toBe(0);
    expect(r.check.collisions).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});

describe('the jaws of a later clamping', () => {
  // A 30 x 34 x 8 plate with a 12 x 24 boss 6 high (cells i 4..16, j 5..29), and a hole from the plate's
  // bottom: through the plate beside the boss, up into the boss 1 mm short of its top. Turned over, the
  // jaws hold the boss and the stop touches its X- face (i 4): a hole across one of its faces stands half
  // over a jaw or the stop, and its part in the boss goes below the jaw top.
  const bossPlate = (hole: (i: number, j: number) => boolean, plate = (_i: number, _j: number) => true) => {
    const boss = (i: number, j: number) => i >= 4 && i < 16 && j >= 5 && j < 29;
    const lo = Array.from({ length: 34 }, (_, j) => Array.from({ length: 30 }, (_, i) => (hole(i, j) && boss(i, j) ? 13 : 0)));
    const hi = Array.from({ length: 34 }, (_, j) => Array.from({ length: 30 }, (_, i) => (hole(i, j) && !boss(i, j) ? 0 : boss(i, j) ? 14 : plate(i, j) ? 8 : 0)));
    return columnPart(lo, hi);
  };
  // The hole across the boss's X- face, at the stop after the turn (6 x 6, i 1..7).
  const atStop = bossPlate((i, j) => i >= 1 && i < 7 && j >= 14 && j < 20);
  /** Points (every 0.5 mm along each move) where the tool goes into the stop plate below the jaw top, between the jaws (the plate before the face the G52 puts at the stop). */
  const intoStop = (tp: ReturnType<typeof parseToolpath>, s: ReturnType<typeof analyseProgram>['setups'][number]) =>
    tp.moves.filter((m) => m.setup === s.index).flatMap((m) => {
      const r = (m.dia ?? tp.tools.find((t) => t.tool === m.tool)?.diameter ?? 0) / 2 || 1;
      const along = m.points.flatMap((p, k) => {
        const q = m.points[k - 1] ?? p;
        const n = Math.max(1, Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / 0.5));
        return Array.from({ length: n }, (_, t) => q.map((v, d) => v + ((p[d] - v) * (t + 1)) / n));
      });
      return along.filter((p) => p[2] < s.jawTopZ! - 0.01 && p[0] - r < s.clampBox!.min[0] && p[0] + r > s.clampBox!.min[0] - STOP_PLATE && p[1] + r > s.clampBox!.min[1] && p[1] - r < s.clampBox!.max[1]);
    });

  it('counts a tool into the X stop below the jaw top as a collision (a review found the check blind there)', () => {
    const r = camProgram({ tris: atStop, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 38, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    const an = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT });
    const s = an.setups[1];
    const [x0, y, z] = [s.clampBox!.min[0] - STOP_PLATE, ((s.clampBox!.min[1] + s.clampBox!.max[1]) / 2).toFixed(3), (s.jawTopZ! - 1).toFixed(3)];
    // The program with moves more at its end, 1 mm below the jaw top: a plunge into the middle of the stop
    // plate, a rapid one into it, and a cut along X from before the plate through it into the hole (its ends
    // clear of the plate: only the points between them go into it).
    const end = r.code.lastIndexOf('\n', r.code.lastIndexOf('M09')) + 1;
    for (const moves of [
      `G00 X${(x0 + STOP_PLATE / 2).toFixed(3)} Y${y}\nG01 Z${z} F300.\nG00 Z50.\n`,
      `G00 X${(x0 + 1.5).toFixed(3)} Y${y}\nG00 Z${z}\nG00 Z50.\n`,
      `G00 X${(x0 - 3).toFixed(3)} Y${y}\nG01 Z${z} F300.\nG01 X${(s.clampBox!.min[0] + 2.5).toFixed(3)}\nG00 Z50.\n`,
    ]) {
      const c = checkProgram(atStop, r.code.slice(0, end) + moves + r.code.slice(end), 'HAAS', undefined, r.pose);
      expect(c.stops, moves).toBeGreaterThan(r.check.stops);
      expect(c.collisions, moves).toBeGreaterThan(r.check.collisions);
    }
  }, 300_000);

  it('looks for the stop where the G52 puts it, not where the simulation has the part (a review found a tool 0.075 mm into it unseen)', () => {
    // A seal cage whose first clamping's finishing the operator left out: 0.15 mm stays on the faces held next,
    // so the part sits that far from where the program puts it. The stop stands at the G52's face.
    const input = { tris: atStop, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 38, 18] as [number, number, number], noNest: true, partType: 'sealCage' as const, orient: { side: 'Z+', spin: false } };
    const all = camProgram(input);
    const r = camProgram({ ...input, skip: all.setups[0].ops.filter((o) => o.kind === 'finish').map((o) => o.key!) });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const s = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT }).setups[1];
    expect(s.clampBox!.min[0] - s.grip!.stop).toBeGreaterThan(0.1);
    expect(r.check.stops).toBe(0);
    // A plunge 1 mm below the jaw top, its edge 0.075 mm past the G52's face: in the stop on the machine.
    const last = tp.moves.filter((m) => m.setup === 1 && m.tool != null).at(-1)!;
    const radius = (last.dia ?? tp.tools.find((t) => t.tool === last.tool)!.diameter!) / 2;
    const end = r.code.lastIndexOf('\n', r.code.lastIndexOf('M09')) + 1;
    const plunge = `G00 X${(s.clampBox!.min[0] + radius - 0.075).toFixed(3)} Y${((s.clampBox!.min[1] + s.clampBox!.max[1]) / 2).toFixed(3)}\nG01 Z${(s.jawTopZ! - 1).toFixed(3)} F300.\nG00 Z50.\n`;
    const c = checkProgram(atStop, r.code.slice(0, end) + plunge + r.code.slice(end), 'HAAS', undefined, r.pose);
    expect(c.stops).toBeGreaterThan(r.check.stops);
  }, 300_000);

  // Each as a plain part and as a top plate, whose walls are roughed 0.15 mm out and finished by other calls.
  it.each([undefined, 'topPlate' as const])('keeps every tool off the X stop below the jaw top where the part above stands out past the face it touches (a review found 3 mm into it; part type %s)', (partType) => {
    const r = camProgram({ tris: atStop, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 38, 18], noNest: true, partType, orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
    // The case itself: held by the boss (12 along the jaws), a mill cutting the hole in it below the jaw top.
    expect(r.setups[1].held[2] - r.setups[1].held[0]).toBeCloseTo(12, 0);
    const s = an.setups[1];
    expect(tp.moves.some((m) => m.setup === 1 && m.kind === 'feed' && m.points.some((p) => p[2] < s.jawTopZ! - 0.5 && p[0] < s.clampBox!.min[0] + 3))).toBe(true);
    expect(intoStop(tp, s)).toEqual([]);
    expect(r.check.stops).toBe(0);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it.each([undefined, 'topPlate' as const])('keeps every tool off the jaws below their top where the part above overhangs what they hold (the validation found 270 hits; part type %s)', (partType) => {
    // The hole across the boss's Y- face (4 x 4): half beside the boss, half in it.
    const tris = bossPlate((i, j) => i >= 8 && i < 12 && j >= 3 && j < 7);
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 38, 18], noNest: true, partType, orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
    expect(an.setups.length).toBeGreaterThanOrEqual(2);
    // The case itself: the second clamping held by the boss (24 mm between the jaws, of the part's 34), and
    // a mill cutting there below the jaw top.
    expect(r.setups[1].held[3] - r.setups[1].held[1]).toBeCloseTo(24, 0);
    const top = an.setups[1].jawTopZ!;
    expect(tp.moves.some((m) => m.setup === 1 && m.kind === 'feed' && m.points.some((p) => p[2] < top - 0.5))).toBe(true);
    expect(an.setups.flatMap((s) => s.collisions).filter((h) => h.what !== 'spacer')).toEqual([]);
    // What it leaves across the hole's opening on the held face, where the mill keeps off the jaw: noted.
    expect(r.notes).toContainEqual(expect.objectContaining({ key: 'jawWall', side: r.setups[1].side }));
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  // Each part stands out past one held side only: its plate as wide as the boss (past the face at the
  // stop), or as long as it (over the jaws). Either alone must keep the tools off.
  it.each([
    { past: 'the stop', hole: (i: number, j: number) => i >= 1 && i < 7 && j >= 14 && j < 20, plate: (_i: number, j: number) => j >= 5 && j < 29, raw: [34, 28, 18] as [number, number, number] },
    { past: 'the jaws', hole: (i: number, j: number) => i >= 8 && i < 12 && j >= 3 && j < 7, plate: (i: number) => i >= 4 && i < 16, raw: [16, 38, 18] as [number, number, number] },
  ])('keeps every tool off what the part stands out past, $past only (a review found either half of that test untested)', ({ past, hole, plate, raw }) => {
    const r = camProgram({ tris: bossPlate(hole, plate), material: 'ALU', tools: [], brand: 'HAAS', raw, noNest: true, orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const s = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT }).setups[1];
    // The case: held by the boss (12 x 24), a mill cutting the hole below the jaw top next to that held face.
    const held = r.setups[1].held;
    expect([held[2] - held[0], held[3] - held[1]].map(Math.round)).toEqual([12, 24]);
    // (after the turn the hole across the boss's Y- face may lie at either jaw)
    const near = (p: number[]) => (past === 'the stop' ? p[0] < s.clampBox!.min[0] + 3 : p[1] < s.clampBox!.min[1] + 3 || p[1] > s.clampBox!.max[1] - 3);
    expect(tp.moves.some((m) => m.setup === 1 && m.kind === 'feed' && m.points.some((p) => p[2] < s.jawTopZ! - 0.5 && near(p)))).toBe(true);
    expect(r.check.stops).toBe(0);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it('asks for no smaller end mill for what lies where no tool may go (a review found a Ø1 asked for)', () => {
    // The hole across the boss's Y- face, 10 wide; a blank whose grid shows the cut face a quarter cell out.
    const tris = bossPlate((i, j) => i >= 5 && i < 15 && j >= 3 && j < 7);
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 39.3, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    expect(r.setups[1].held[3] - r.setups[1].held[1]).toBeCloseTo(24, 0);
    expect(r.missing.filter((m) => m.why.key === 'narrow')).toEqual([]);
    expect(r.check.collisions).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  // As bossPlate, len mm long: the boss 10 mm shorter than the plate (i 4..len-6).
  const longBossPlate = (len: number, hole: (i: number, j: number) => boolean) => {
    const boss = (i: number, j: number) => i >= 4 && i < len - 6 && j >= 5 && j < 29;
    const lo = Array.from({ length: 34 }, (_, j) => Array.from({ length: len }, (_, i) => (hole(i, j) && boss(i, j) ? 13 : 0)));
    const hi = Array.from({ length: 34 }, (_, j) => Array.from({ length: len }, (_, i) => (hole(i, j) && !boss(i, j) ? 0 : boss(i, j) ? 14 : 8)));
    return columnPart(lo, hi);
  };

  it('keeps off the jaws only where they stand: not past their end, 142 mm from the stop (a review found the whole length kept off)', () => {
    // A 160 mm plate with a 150 x 24 boss, and the 4 x 4 hole across the boss's Y- face 144 mm from its X- face.
    const len = 160;
    const tris = longBossPlate(len, (i, j) => i >= 148 && i < 152 && j >= 3 && j < 7);
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [len + 4, 38, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const s = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT }).setups[1];
    expect(r.setups[1].held[2] - r.setups[1].held[0]).toBeCloseTo(150, 0);
    // The hole lies past the jaws' end: a mill wider than its half in the boss cuts it all, and no wall is left.
    expect(tp.moves.some((m) => m.setup === 1 && m.kind === 'feed' && (m.dia ?? 0) > 2 && m.points.some((p) => p[2] < s.jawTopZ! - 0.5 && p[0] - m.dia! / 2 > s.jawX[1]))).toBe(true);
    expect(r.notes.filter((n) => n.key === 'jawWall')).toEqual([]);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it('keeps a mill rounding the jaws\' end clear of them as the check takes it, by the tool\'s square (a review found 2 hits clear of the jaw)', () => {
    // A 180 x 70 x 12 plate with a 170 x 34 boss 8 high (i 4..174, j 18..52), and a 36 x 30 pocket across the
    // boss's Y- face and the jaws' end (142 mm from the boss's X- face): through the plate beside the boss,
    // into it 1 mm short of its top.
    const boss = (i: number, j: number) => i >= 4 && i < 174 && j >= 18 && j < 52;
    const hole = (i: number, j: number) => i >= 130 && i < 166 && j >= 2 && j < 32;
    const lo = Array.from({ length: 70 }, (_, j) => Array.from({ length: 180 }, (_, i) => (hole(i, j) && boss(i, j) ? 19 : 0)));
    const hi = Array.from({ length: 70 }, (_, j) => Array.from({ length: 180 }, (_, i) => (hole(i, j) && !boss(i, j) ? 0 : boss(i, j) ? 20 : 12)));
    const r = camProgram({ tris: columnPart(lo, hi), material: 'ALU', tools: [], brand: 'HAAS', raw: [184, 74, 24], noNest: true, orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const s = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT }).setups[1];
    // The case: a mill of Ø8 or more cutting below the jaw top past the jaws' end, next to a held face.
    const dia = (m: (typeof tp.moves)[number]) => m.dia ?? tp.tools.find((t) => t.tool === m.tool)?.diameter ?? 0;
    const nextToJaw = (p: number[], d: number) => p[1] < s.clampBox!.min[1] + d || p[1] > s.clampBox!.max[1] - d;
    expect(tp.moves.some((m) => m.setup === 1 && m.kind === 'feed' && dia(m) >= 8 && m.points.some((p) => p[2] < s.jawTopZ! - 0.5 && p[0] > s.jawX[1] && nextToJaw(p, dia(m))))).toBe(true);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it('keeps off the second vise\'s jaws too, holding a part in both (a review found it untested)', () => {
    // A 230 mm plate with a 220 x 24 boss, held in both vises, and the 4 x 4 hole across the boss's Y- face
    // 200 mm from its X- face: in the second vise (from 192 mm).
    const tris = longBossPlate(230, (i, j) => i >= 204 && i < 208 && j >= 3 && j < 7);
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [234, 38, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    const s = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT }).setups[1];
    expect(s.twoVises).toBe(true);
    expect(r.setups[1].notes).toContain('MIT 2 SCHRAUBSTOECKEN 50 MM ABSTAND');
    // Kept off that jaw: the hole's opening onto the held face keeps its thin wall, noted.
    expect(r.notes).toContainEqual(expect.objectContaining({ key: 'jawWall', side: r.setups[1].side }));
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it('notes the thin wall the jaws leave across a pocket that opens onto a held face, and plans no clamping more for it (a review found a third one, misplaced)', () => {
    // As above, on a blank whose grid shows that wall (under 0.1 mm thick) a whole cell thick.
    const tris = bossPlate((i, j) => i >= 5 && i < 15 && j >= 3 && j < 7);
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 38.1, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    expect(r.setups).toHaveLength(2);
    expect(r.notes).toContainEqual(expect.objectContaining({ key: 'jawWall', side: r.setups[1].side }));
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});

describe('where a clamping puts the part, with side stock or in the nest', () => {
  it('writes the size the jaws hold with the side stock the operator asked for (walls left 0.3 mm out)', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, sideStock: 0.3, orient: { side: 'Z+', spin: false } });
    const turned = r.code.match(/DREHEN\/(\d+(?:\.\d+)?) IN X UND (\d+(?:\.\d+)?) IN Y/)!;
    // The walls stand 0.3 mm out of the model: the jaws hold 40.6 x 30.6, not the model's 40 x 30.
    expect(Number(turned[1])).toBeCloseTo(40.6, 1);
    expect(Number(turned[2])).toBeCloseTo(30.6, 1);
    // The deburring runs round those walls (0.2 mm outside them), not into the stock left on them.
    const deburr = r.setups[0].ops.find((o) => o.name === 'ENTGRATEN')!;
    const xs = deburr.lines.filter((l) => /^G01 X/.test(l)).map((l) => Math.abs(Number(l.match(/X(-?[\d.]+)/)![1])));
    expect(Math.max(...xs)).toBeCloseTo(20.5, 1);
  }, 300_000);

  it('makes the nest’s pocket round what sits in it, and puts the part by it (a review found it placed by the whole stock)', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], nestSides: ['Z-'], orient: { side: 'Z+', spin: false } });
    const s = r.setups.find((x) => x.nest)!;
    expect(s).toBeTruthy();
    // After the first clamping the part's lower faces are its finished 40 x 30 walls: the pocket is 0.1 mm over them.
    const p = s.nest!.pocket;
    expect(p.hi[0] - p.lo[0]).toBeCloseTo(40.2, 1);
    expect(p.hi[1] - p.lo[1]).toBeCloseTo(30.2, 1);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 600_000);
});

describe('turning the part over', () => {
  it('reaches a later clamping with one turn where one will do (a review found two after the turn about X)', () => {
    // A 40 x 30 x 12 block with an off-centre pocket and a step on its top, laid X+ up first.
    const tris = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 4 && i < 16 && j >= 5 && j < 14 ? 6 : i >= 30 && i < 38 && j >= 20 && j < 28 ? 9 : 12))));
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', noNest: true, orient: { side: 'X+', spin: false } });
    expect(r.setups.length).toBeGreaterThanOrEqual(3);
    expect(r.setups[1].notes[0]).toMatch(/^TEIL 180 GRAD UM X DREHEN\//);
    for (const s of r.setups.slice(2)) expect((s.notes[0].match(/DREHEN/g) ?? []).length, s.notes[0]).toBe(1);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('turns it about X, as the shop mostly does (docs/knowledge: second clamping X180 in 63 of 100, Y180 in 31), laid along X or across', () => {
    for (const spin of [false, true]) {
      const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin } });
      expect(r.setups[1].notes[0], `spin ${spin}`).toMatch(/^TEIL 180 GRAD UM X DREHEN\//);
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    }
  }, 600_000);
});

