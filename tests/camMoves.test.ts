import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTris } from '../src/lib/model';
import { forMachine } from '../src/lib/cam/export';
import { camProgram, oneClamping, RESERVE, zigzag, type CamSetup } from '../src/lib/cam/program';
import { area, simplify, type P2 } from '../src/lib/cam/geom';
import { LIBRARY } from '../src/lib/cam/tools';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { columnPart, heightPart, plateWithBlindHole, plateWithBoss, plateWithCounterbore, plateWithHoles, pocketPart, roundedRect } from './heightPart';

// How CAM AI moves the tool between and into its cuts, against the engineers' programs (Phase 6).

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
// A 30x24x10 block with a pocket in each face: 10x8, 4 deep on top; 8x6, 3 deep underneath.
const twoSided = columnPart(
  Array.from({ length: 24 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 16 && i < 24 && j >= 12 && j < 18 ? 3 : 0))),
  Array.from({ length: 24 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 4 && i < 14 && j >= 4 && j < 12 ? 6 : 10))),
);
const base = { material: 'ALU' as const, tools: [], brand: 'HAAS', noNest: true, orient: { side: 'Z+', spin: false } };

/** Each straight feed move of an op: from and to (x, y, z; the op's lines are absolute, every one with its G code). */
function feeds(lines: string[]): [number, number, number][][] {
  let p: [number, number, number] = [NaN, NaN, NaN];
  const out: [number, number, number][][] = [];
  for (const l of lines) {
    const v = (a: string, was: number) => Number(l.match(new RegExp(`${a}(-?[\\d.]+)`))?.[1] ?? was);
    const q: [number, number, number] = [v('X', p[0]), v('Y', p[1]), v('Z', p[2])];
    if (/^G0?1\b/.test(l)) out.push([p, q]);
    p = q;
  }
  return out;
}

/** The face mill's passes at Z0 cover the whole stock (its box in the clamping's frame, every 0.25 mm). */
function facedAll(s: CamSetup): boolean {
  const op = s.ops.find((o) => o.kind === 'face')!;
  const r = op.tool.diameter / 2;
  const at0 = feeds(op.lines).filter(([a, b]) => Math.abs(a[2]) < 1e-6 && Math.abs(b[2]) < 1e-6);
  const near = (x: number, y: number) =>
    at0.some(([a, b]) => {
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= r;
    });
  const [x0, y0, x1, y1] = s.box;
  for (let x = x0; x <= x1 + 1e-9; x += 0.25) for (let y = y0; y <= y1 + 1e-9; y += 0.25) if (!near(x, y)) return false;
  return true;
}

describe('milling after the face is cut', () => {
  it('cuts nothing above Z0 once the face mill has taken it (shop: strategy.faceFirst), and from the raw top when the operator removed the facing', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // The operations in the program in the order planned (the facing first in its clamping).
    expect([...r.code.matchAll(/\(TOOLPATH ([^)]+)\)/g)].map((m) => m[1])).toEqual(r.setups.flatMap((s) => s.ops.map((o) => o.name)));
    const faced = r.setups.filter((s) => s.ops.some((o) => o.kind === 'face'));
    expect(faced.length).toBe(2);
    for (const s of faced) {
      expect(s.ops[0].kind, s.side).toBe('face');
      // Nothing stands above Z0 after the facing: its passes at Z0 cover the whole stock.
      expect(facedAll(s), s.side).toBe(true);
      for (const o of s.ops.filter((x) => x.kind === 'pocket' || x.kind === 'finish')) expect(Math.max(...feeds(o.lines).map(([, b]) => b[2])), `${s.side} ${o.name}`).toBeLessThanOrEqual(0.001);
    }
    // The operator removed the facing of the first clamping: its milling starts at the raw top (2 mm above Z0).
    const kept = camProgram({ ...base, tris: plate, raw: [44, 34, 16], skip: [r.setups[0].ops[0].key!] });
    expect(kept.setups[0].ops.some((o) => o.kind === 'face')).toBe(false);
    expect(Math.max(...kept.setups[0].ops.filter((o) => o.kind === 'pocket').flatMap((o) => feeds(o.lines).map(([, b]) => b[2])))).toBeGreaterThan(0.5);
  }, 600_000);

  it('faces the whole stock with the largest end mill when there is no face mill', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16], exclude: LIBRARY.ALU.filter((t) => t.type === 'MK').map((t) => t.code) });
    const faced = r.setups.filter((s) => s.ops.some((o) => o.kind === 'face'));
    expect(faced.length).toBe(2);
    for (const s of faced) {
      expect(s.ops[0].tool.type, s.side).not.toBe('MK');
      expect(facedAll(s), s.side).toBe(true);
    }
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('plans no rings round a later clamping’s outside that the first clamping already cut through', () => {
    // Raw 22 high: 6 mm under the part in the first clamping, gripped 5 mm, so its outside goes 0.2 mm under the part.
    const r = camProgram({ ...base, tris: twoSided, raw: [34, 28, 22] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.setups.map((s) => s.side)).toEqual(['Z+', 'Z-']);
    const mills = (s: CamSetup) => s.ops.filter((o) => o.name.startsWith('FRAESEN'));
    expect(Math.min(...mills(r.setups[0]).flatMap((o) => feeds(o.lines).map(([, b]) => b[2])))).toBeLessThanOrEqual(-10.15);
    // Turned over, only the 8x6 pocket is left to mill: every end mill stays over the part (the held band is the part).
    const [x0, y0, x1, y1] = r.setups[1].held;
    for (const o of mills(r.setups[1]))
      for (const [, b] of feeds(o.lines)) {
        expect(b[0], o.name).toBeGreaterThanOrEqual(x0 - 0.5);
        expect(b[0], o.name).toBeLessThanOrEqual(x1 + 0.5);
        expect(b[1], o.name).toBeGreaterThanOrEqual(y0 - 0.5);
        expect(b[1], o.name).toBeLessThanOrEqual(y1 + 0.5);
      }
  }, 300_000);
});

describe('the plane between cuts', () => {
  // The rapids' heights in one clamping's operations after its facing: the lifts (G00 Z) and each drill cycle's start (its R).
  const lifts = (s: CamSetup) => s.ops.filter((o) => o.kind !== 'face').flatMap((o) => o.lines.flatMap((l) => (/^G00 Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : [])));
  const rPlanes = (s: CamSetup) => s.ops.flatMap((o) => o.lines.flatMap((l) => (/ R(-?[\d.]+)/.test(l) ? [Number(l.match(/ R(-?[\d.]+)/)![1])] : [])));

  it('is Z2, 2 mm above the faced top, for every operation after the facing and every drill cycle (the shop’s links and R2)', () => {
    // A Ø3.3 and a Ø5 hole through a 40 x 30 x 8 plate, 2 mm of stock on top.
    const holed = plateWithHoles(40, 30, 8, [{ c: [10, 15], d: 3.3 }, { c: [30, 15], d: 5 }]);
    const r = camProgram({ ...base, tris: holed, raw: [44, 34, 12] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    const s = r.setups[0];
    expect(s.ops[0].kind).toBe('face');
    expect(s.ops.some((o) => o.kind === 'drill')).toBe(true);
    expect(Math.max(...lifts(s))).toBeCloseTo(2, 3);
    for (const z of rPlanes(s)) expect(z).toBeLessThanOrEqual(2.001);
    // The cycles start from Z2: the move before each G98 G8x.
    for (const o of s.ops.filter((x) => x.kind === 'drill' || x.kind === 'centre')) expect(o.lines[o.lines.findIndex((l) => /G98 G8/.test(l)) - 1]).toBe('G00 Z2.');
    // The facing removed by the operator: the raw top stays, the plane stays 2 mm above it (Z4), and so do
    // the drill cycles' R (never on the raw top: a review finding).
    const kept = camProgram({ ...base, tris: holed, raw: [44, 34, 12], skip: [s.ops[0].key!] });
    expect(Math.max(...lifts(kept.setups[0]))).toBeCloseTo(4, 3);
    expect(rPlanes(kept.setups[0]).length).toBeGreaterThan(0);
    for (const z of rPlanes(kept.setups[0])) expect(z).toBeGreaterThanOrEqual(3.999);
  }, 300_000);
});

describe('the order of the operations', () => {
  // You: the engineers cut the outline first, then spot-drill, then drill, and only then mill inside the part.
  it('faces, cuts the outline, spot-drills, drills, then mills inside', () => {
    // A 60 x 40 x 10 plate: a Ø3.3 hole (drilled) and a Ø16 one (no drill: milled inside).
    const holed = plateWithHoles(60, 40, 10, [{ c: [15, 20], d: 3.3 }, { c: [40, 20], d: 16 }]);
    const r = camProgram({ ...base, tris: holed, raw: [64, 44, 17] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    const ops = r.setups[0].ops;
    const at = (k: string) => ops.findIndex((o) => o.kind === k);
    expect(ops[0].kind).toBe('face');
    expect(ops[1]).toMatchObject({ kind: 'pocket', purpose: 'outline' });
    expect(at('centre')).toBe(2);
    expect(at('drill')).toBe(3);
    // Every other milling after the drills.
    expect(ops.slice(4).filter((o) => o.kind === 'pocket').length).toBeGreaterThan(0);
    expect(ops.slice(0, 4).filter((o) => o.kind === 'pocket')).toHaveLength(1);
  }, 300_000);

  it('leaves for after the drills any outline pass over a hole (the spot drill would meet only air)', () => {
    // A 60 x 40 x 6 plate with a 30 x 20 boss 8 high, two Ø3.3 holes 5 mm from the plate's corners: the outline
    // passes round the plate above its top (beside the boss) sweep 8 mm in, over the holes.
    const tris = plateWithBoss(60, 40, 6, { lo: [15, 10], hi: [45, 30], h: 8 }, [{ c: [5, 5], d: 3.3 }, { c: [55, 35], d: 3.3 }]);
    const r = camProgram({ ...base, tris, raw: [64, 44, 21] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    const ops = r.setups[0].ops;
    const outline = ops.find((o) => o.purpose === 'outline');
    expect(outline).toBeDefined();
    // Every point the outline cuts above the plate's top (Z-8) stays a tool radius and a hole radius off the holes.
    let [x, y, z, mode] = [0, 0, 0, 0];
    const near: number[] = [];
    for (const l of outline!.lines) {
      const g = l.match(/\bG0?([0123])\b/);
      if (g) mode = Number(g[1]);
      x = Number(l.match(/X(-?[\d.]+)/)?.[1] ?? x);
      y = Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? y);
      z = Number(l.match(/ Z(-?[\d.]+)/)?.[1] ?? z);
      if (mode > 0 && z > -8 + 0.01) near.push(Math.min(...[[-25, -15], [25, 15]].map(([hx, hy]) => Math.hypot(x - hx, y - hy))));
    }
    expect(Math.min(...near)).toBeGreaterThan(outline!.tool.diameter / 2 + 3.3 / 2);
  }, 300_000);

  it('keeps one operation per mill where nothing is drilled between (no tool change for nothing)', () => {
    const r = camProgram({ ...base, tris: pocketPart(40, 30, 12, [[10, 9], [30, 9], [30, 21], [10, 21]], 6), raw: [44, 34, 19] });
    const mills = r.setups[0].ops.filter((o) => o.kind === 'pocket').map((o) => o.tool.diameter);
    expect(new Set(mills).size).toBe(mills.length);
    expect(r.setups[0].ops.some((o) => o.purpose === 'outline')).toBe(false);
  }, 300_000);
});

describe('one face, one clamping', () => {
  // A 40 x 30 x 12 plate with a 20 x 12 pocket 6 deep: its wall at x = 30 (facing -X) given to a later clamping.
  const plate = pocketPart(40, 30, 12, [[10, 9], [30, 9], [30, 21], [10, 21]], 6);
  const wall: number[] = [];
  for (let i = 0; i < plate.length; i += 9) {
    const [ax, ay, , bx, by, , cx, cy] = [plate[i], plate[i + 1], plate[i + 2], plate[i + 3], plate[i + 4], plate[i + 5], plate[i + 6], plate[i + 7]];
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if ([ax, bx, cx].every((x) => Math.abs(x - 30) < 1e-6) && Math.abs(nz) < 1e-9) wall.push(i / 9);
  }

  it('keeps RESERVE off a face a later clamping finishes whole', () => {
    expect(wall.length).toBeGreaterThan(0);
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 19], reserve: [{ side: 'Z+', tris: wall }] });
    // The wall at x = 10 in the program (the part centred): every end mill's centre stays its radius and RESERVE off it.
    for (const o of r.setups[0].ops.filter((x) => x.kind === 'pocket')) {
      let [x, y, mode] = [0, 0, 0];
      for (const l of o.lines) {
        const g = l.match(/\bG0?([0123])\b/);
        if (g) mode = Number(g[1]);
        x = Number(l.match(/X(-?[\d.]+)/)?.[1] ?? x);
        y = Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? y);
        if (mode > 0 && Math.abs(y) < 6 - o.tool.diameter / 2 && x > 0) expect(x).toBeLessThanOrEqual(10 - o.tool.diameter / 2 - RESERVE + 0.05);
      }
    }
  }, 300_000);

  it('finds no face finished in two clampings on a plate one clamping makes', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 19] });
    expect(oneClamping(plate, r.code, 'HAAS', undefined, r.pose!, r.setups.map((x) => x.side))).toMatchObject({ reserve: [], splitMm2: 0 });
  }, 300_000);
});

describe('a chamfer', () => {
  // You (Beta 2, 13): no chamfer without need. A 45° face is a chamfer from two sides: cut once, never again after a turn.
  it('is cut in one clamping only', async () => {
    // tools/test-part/make_chamfer_slot.py: 50 x 30 x 20, 1 x 45° round the top, a slot 6 deep in the Y- face.
    const tris = await readTris(new Uint8Array(readFileSync('tests/models/chamfer-side-slot.stl')));
    if ('error' in tris) throw new Error(tris.error);
    const r = camProgram({ ...base, tris, raw: [54, 34, 27] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.setups.map((s) => s.side)).toContain('Y-');
    expect(r.setups.map((s) => `${s.side} ${s.ops.filter((o) => o.name === 'FASE').length}`)).toEqual(r.setups.map((s) => `${s.side} ${s.side === 'Z+' ? 1 : 0}`));
  }, 300_000);
});

describe('a drilled hole', () => {
  // You (Beta 2, 9 and 17): a hole drilled at its size is done; no mill goes in after the drill.
  it('is never milled again after the drill', () => {
    // A 60 x 40 x 10 plate: Ø3.3, Ø5 and Ø6.4 through, all drills CAM AI has.
    const holes: { c: [number, number]; d: number }[] = [{ c: [15, 20], d: 3.3 }, { c: [30, 20], d: 5 }, { c: [45, 20], d: 6.4 }];
    const r = camProgram({ ...base, tris: plateWithHoles(60, 40, 10, holes), raw: [64, 44, 17] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    const s = r.setups[0];
    expect(s.ops.filter((o) => o.kind === 'drill').map((o) => o.tool.diameter).sort((p, q) => p - q)).toEqual([3.3, 5, 6.4]);
    // Every mill's feed below the top, each point every 0.2 mm: its centre never inside a drilled hole.
    const inHoles: string[] = [];
    for (const o of s.ops.filter((x) => x.kind !== 'drill' && x.kind !== 'centre' && x.kind !== 'chamfer'))
      for (const [a, b] of feeds(o.lines)) {
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.2));
        for (let i = 0; i <= n; i++) {
          const q = [0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * i) / n);
          const h = holes.find((x) => q[2] < -0.2 && Math.hypot(q[0] - (x.c[0] - 30), q[1] - (x.c[1] - 20)) < x.d / 2);
          if (h) inHoles.push(`${o.name} in Ø${h.d}`);
        }
      }
    expect([...new Set(inHoles)]).toEqual([]);
  }, 300_000);
});

describe('a hole and its counterbore', () => {
  // You: a hole with a bigger one round it (a counterbore) is made in the same clamping as it, never the two from
  // either side after a turn (they would not meet on one axis).
  it('drills the hole from the counterbore’s side, with it', () => {
    // A 40 x 30 x 12 plate: a Ø5 hole through, a Ø10 counterbore 5 deep from its bottom face.
    const tris = plateWithCounterbore(40, 30, 12, { c: [12, 15], d: 5, D: 10, depth: 5 });
    const r = camProgram({ ...base, tris, raw: [44, 34, 19] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // Where each clamping's drills go down (X, Y of each cycle line), by drill Ø.
    const cycles = (s: CamSetup) => s.ops.filter((o) => o.kind === 'drill').flatMap((o) => o.lines.filter((l) => /G8[123]/.test(l)).map((l) => `${o.tool.diameter}@${Math.abs(Number(l.match(/X(-?[\d.]+)/)![1]))},${Math.abs(Number(l.match(/Y(-?[\d.]+)/)![1]))}`));
    const [top, bottom] = [r.setups.find((s) => s.side === 'Z+')!, r.setups.find((s) => s.side === 'Z-')!];
    expect(cycles(top)).toEqual([]);
    expect(cycles(bottom).sort()).toEqual(['10@8,0', '5@8,0']);
  }, 300_000);
});

describe('blind holes', () => {
  // The study (docs/knowledge/cam-part-study.md, E3): CAM AI put the drill's point where the hole's wall ends, so
  // the full Ø stopped 0.3 x Ø short; the engineers drill to the point CAD draws (Z-28.642 for a wall ending at 27.2).
  const drillZ = (point: boolean) => {
    const tris = plateWithBlindHole(40, 30, 12, { c: [20, 15], d: 5, depth: 8, point });
    const r = camProgram({ ...base, tris, raw: [44, 34, 16] });
    const cycle = r.setups[0].ops.filter((o) => o.kind === 'drill').flatMap((o) => o.lines).find((l) => /G83/.test(l));
    return Number(cycle?.match(/ Z(-?[\d.]+)/)?.[1]);
  };
  it('drills a hole drawn with a drill point to that point (its wall 8 deep, Ø5: Z-9.5)', () => {
    expect(drillZ(true)).toBeCloseTo(-9.5, 2);
  }, 300_000);
  it('stops a flat-bottomed hole where its wall ends', () => {
    expect(drillZ(false)).toBeCloseTo(-8, 2);
  }, 300_000);
});

describe('the roughing mill', () => {
  // The study: CAM AI roughed with the largest mill, the Ø30 (the shop's POM data: 1000 rpm, F500, 8 deep), 10 minutes;
  // the engineers took the Ø20 (4000 rpm, F1200), 1.7 minutes for the whole outline.
  it('is the one that takes the most material a minute, not the largest', () => {
    const r = camProgram({ ...base, material: 'POM', tris: plate, raw: [44, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    const d = r.setups.flatMap((s) => s.ops).filter((o) => o.name.startsWith('FRAESEN')).map((o) => o.tool.diameter);
    expect(d).not.toContain(30);
    expect(d).toContain(20);
  }, 300_000);
});

describe('inside corners', () => {
  // You: inside corners are left at the radius of the pocket mill (the study: a Ø1 ran 12 minutes in 0.4 mm corner
  // slivers 30 mm deep; the engineers stop at Ø6, Ø4 only where it is narrower).
  const pocket = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
  // The same with a slot 3 wide, 6 long, 4 deep off the pocket's side (y 6 to 12): only a Ø3 or smaller reaches into it.
  const slotted = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : i >= 19 && i < 22 && j >= 21 && j < 27 ? 8 : 12))));
  const mills = (tris: Float32Array) => {
    const r = camProgram({ ...base, material: 'POM', tris, raw: [44, 34, 16] });
    return { r, d: r.setups.flatMap((s) => s.ops).filter((o) => /^(FRAESEN|SCHLICHT)/.test(o.name)).map((o) => o.tool.diameter) };
  };
  it('sends no smaller mill after the pocket mill only for its corners', () => {
    const { r, d } = mills(pocket);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(6);
    // The corners left on purpose are not counted as material left (they were 4 pieces of 5 mm³).
    expect(r.check.pieces.filter((p) => p.kind === 'left')).toEqual([]);
  }, 300_000);
  it('cuts a strip along a wall that only lies near the pocket mill\'s path: no corner (a review found it left)', () => {
    // The pocket 1 mm deeper into its wall over 10 mm (y 6 to 7, x -5 to 5): within reach of the Ø8's path, not a corner.
    const recess = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => ((i >= 10 && i < 30 && j >= 9 && j < 21) || (i >= 15 && i < 25 && j === 21) ? 6 : 12))));
    const { r } = mills(recess);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.pieces.filter((p) => p.kind === 'left' && p.max[1] > 5.9 && p.min[0] > -6 && p.max[0] < 6)).toEqual([]);
    // What the check accepts as left on purpose: corner-sized pieces only (a Ø8's square corner: 0.215 x 16 mm²).
    for (const c of r.corners ?? []) for (const loop of c.region) expect(Math.abs(area([loop]))).toBeLessThan(0.215 * 16 * 1.2 + 0.01);
  }, 300_000);

  it('makes a corner the model draws with a radius (R2): a mill that small, nothing of it taken as left on purpose', () => {
    const { r, d } = mills(pocketPart(40, 30, 12, roundedRect([10, 9, 30, 21], 2), 6));
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    // A Ø5 at most (from R2.5 to R2 is under 0.5 mm² a level: not worth a tool change, the planner's own rule).
    expect(Math.min(...d)).toBeLessThanOrEqual(5);
    expect(r.corners ?? []).toEqual([]);
  }, 300_000);

  it('leaves sharp corners of any angle at the pocket mill\'s radius (a hexagon: 120°)', () => {
    const hex = Array.from({ length: 6 }, (_, k) => [20 + 9 * Math.cos((k * Math.PI) / 3), 15 + 9 * Math.sin((k * Math.PI) / 3)] as [number, number]);
    const { r, d } = mills(pocketPart(40, 30, 12, hex, 6));
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(6);
  }, 300_000);

  it('still sends one into a place narrower than the pocket mill', () => {
    const { r, d } = mills(slotted);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(d.some((x) => x <= 3)).toBe(true);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(2);
    // Nothing left in the slot; the pocket's corners only (at the pocket mill's radius).
    expect(r.check.pieces.filter((p) => p.kind === 'left' && p.max[1] > 6.5)).toEqual([]);
  }, 300_000);
});

describe('going down into material', () => {
  /** The steepest and the least steep ramp (its whole drop over its whole length: the lines are rounded to 0.001 mm; over 2 mm long for the least) of each end mill's roughing, by tool code. */
  const slopes = (r: ReturnType<typeof camProgram>) => {
    const out = new Map<string, { type: string; d: number; max: number; min: number }>();
    for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.name.startsWith('FRAESEN'))) {
      const e = out.get(o.tool.code) ?? out.set(o.tool.code, { type: o.tool.type, d: o.tool.diameter, max: 0, min: Infinity }).get(o.tool.code)!;
      let [dz, len] = [0, 0];
      for (const m of [...feeds(o.lines), null]) {
        const dxy = m ? Math.hypot(m[1][0] - m[0][0], m[1][1] - m[0][1]) : 0;
        if (m && dxy > 1e-6 && m[0][2] - m[1][2] > 1e-6) [dz, len] = [dz + m[0][2] - m[1][2], len + dxy];
        else {
          if (len > 0.5) e.max = Math.max(e.max, dz / len);
          if (len > 2) e.min = Math.min(e.min, dz / len);
          [dz, len] = [0, 0];
        }
      }
    }
    return [...out.values()].filter((e) => e.max > 0);
  };
  const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

  it('zigzags down a piece shorter than its ramp as steeply as it may, no longer than it needs, back at its start', () => {
    const slope = tan(15);
    for (const piece of [
      [[0, 0], [1.2, 0]],
      [[0, 0], [0.7, 0], [0.7, 0.6]],
      [[0, 0], [5, 0]],
    ] as [number, number][][]) {
      const z = zigzag(piece, 0, -1, slope);
      let [len, p, zPrev] = [0, piece[0] as [number, number], 0];
      for (const q of z) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        expect(zPrev - q[2]).toBeLessThanOrEqual(d * slope + 1e-9);
        expect(q[2]).toBeLessThanOrEqual(zPrev + 1e-12);
        [len, p, zPrev] = [len + d, [q[0], q[1]], q[2]];
      }
      expect(len).toBeCloseTo(1 / slope, 6);
      expect(z.at(-1)).toEqual([0, 0, -1]);
    }
  });

  it('ramps at 15° with the end mills the shop takes in that steeply (ALU Ø2 to 8), at 5° with the high-feed mill and where the shop never does', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    const s = slopes(r);
    const steep = s.filter((e) => e.type === 'SF' && e.d >= 2 && e.d <= 8);
    expect(steep.length).toBeGreaterThan(0);
    for (const e of steep) expect(e.max, `SF ${e.d}`).toBeLessThanOrEqual(tan(15) + 0.001);
    expect(Math.max(...steep.map((e) => e.max))).toBeGreaterThan(tan(10));
    // Every ramp of these as steep as it may be (the zigzag along a short piece: its own test above).
    for (const e of steep.filter((x) => Number.isFinite(x.min))) expect(e.min, `SF ${e.d}`).toBeGreaterThanOrEqual(tan(15) - 0.003);
    for (const e of s.filter((x) => x.type !== 'SF' || x.d < 2 || x.d > 8)) expect(e.max, `${e.type} ${e.d}`).toBeLessThanOrEqual(tan(5) + 0.001);
    // The machine's own roughing mill with no shop template: nothing in the library to go by, 5° (a review finding).
    const own = camProgram({ ...base, tris: plate, raw: [44, 34, 16], tools: [{ id: 'x', number: 7, category: 'fraise ebauche', description: 'FRAISE EBAUCHE D8', diameter: 8, length: 40 }] });
    const rougher = slopes(own).filter((e) => e.d === 8);
    expect(rougher.length).toBeGreaterThan(0);
    for (const e of rougher) expect(e.max, `${e.type} ${e.d}`).toBeLessThanOrEqual(tan(5) + 0.001);
    // Brass: no ramp or plunge into material in the shop's programs to go by: 5° throughout.
    const ms = camProgram({ ...base, material: 'MS', tris: plate, raw: [44, 34, 16] });
    expect(slopes(ms).length).toBeGreaterThan(0);
    for (const e of slopes(ms)) expect(e.max, `MS ${e.type} ${e.d}`).toBeLessThanOrEqual(tan(5) + 0.001);
  }, 300_000);

  it('goes straight down into POM, FH and RESOPAL with the end mills the shop takes in steeply: a whole pass in POM, 2 mm in the others (you)', () => {
    // The study (docs/knowledge/cam-part-study.md): the engineers ramp once into closed material and plunge 2 mm into
    // the next level; CAM AI's ramps were 61 % of its lines. Ø3 to 8, as the shop takes them in steeply.
    for (const material of ['POM', 'FH', 'RESOPAL'] as const) {
      const r = camProgram({ ...base, material, tris: plate, raw: [44, 34, 16] });
      expect(r.check.match, material).toBeGreaterThanOrEqual(0.99);
      expect(r.check.collisions, material).toBe(0);
      // What a pass goes deeper than the plunge: ramped at the shop's steep 15°.
      for (const e of slopes(r).filter((x) => x.type === 'SF' && x.d >= 3 && x.d <= 8)) expect(e.max, `${material} SF ${e.d}`).toBeLessThanOrEqual(tan(15) + 0.001);
      const ops = r.setups.flatMap((x) => x.ops).filter((o) => o.name.startsWith('FRAESEN') && o.tool.type === 'SF' && o.tool.diameter >= 3 && o.tool.diameter <= 8);
      expect(ops.length, material).toBeGreaterThan(0);
      expect(ops.some((o) => o.lines.some((l) => /^G01 Z-/.test(l))), material).toBe(true);
      // FH and RESOPAL: never more than the engineers' 2 mm straight into material (a review found 8), the rest of a
      // deeper pass ramped. POM: a whole pass (you).
      let deepest = 0;
      for (const o of ops)
        o.lines.forEach((l, i) => {
          const [a, b] = [o.lines[i - 1] ?? '', l].map((x) => x.match(/^G01 Z(-?[\d.]+)( F\S+)?$/)?.[1]);
          if (a !== undefined && b !== undefined) deepest = Math.max(deepest, Number(a) - Number(b));
        });
      if (material === 'POM') expect(deepest, material).toBeGreaterThan(2.001);
      else expect(deepest, material).toBeLessThanOrEqual(2.001);
    }
  }, 300_000);
});

describe('entering a ring from the side', () => {
  it('goes down by rapid in the ring already cut and feeds only the last mm (the shop rapids to 2 mm above and feeds in)', () => {
    // A pocket wide enough for more than one ring a level (the small ones are one ring since inside corners are
    // left at the pocket mill's radius): 50 x 40 x 12, 30 x 24, 6 deep.
    const wide = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 50 }, (_, i) => (i >= 10 && i < 40 && j >= 8 && j < 32 ? 6 : 12))));
    let entries = 0;
    for (const [tris, raw] of [
      [wide, [54, 44, 16]],
      [twoSided, [34, 28, 20]],
    ] as const) {
      const r = camProgram({ ...base, tris, raw: [...raw] });
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
      expect(r.check.collisions).toBe(0);
      for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.kind === 'pocket' || x.kind === 'finish'))
        // A rapid down, a feed down, then across at that height (into the ring): the feed down is the last mm.
        o.lines.forEach((l, i) => {
          const zOf = (s: string) => Number(s.match(/Z(-?[\d.]+)/)?.[1]);
          const [next, after] = [o.lines[i + 1] ?? '', o.lines[i + 2] ?? ''];
          if (/^G00 Z/.test(l) && /^G01 Z\S+( F\S+)?$/.test(next) && /^G01 [XY]/.test(after) && !/Z/.test(after)) {
            entries++;
            expect(zOf(l) - zOf(next), `${o.name} line ${i}`).toBeLessThanOrEqual(1.001);
          }
        });
    }
    expect(entries).toBeGreaterThan(0);
  }, 300_000);

  it('never runs back over a cut at feed: an open piece’s zigzag down ends at its start, where its pass begins (the shop’s zigzag, no walk back)', () => {
    for (const [tris, raw] of [
      [plate, [44, 34, 16]],
      [twoSided, [34, 28, 20]],
    ] as const) {
      const r = camProgram({ ...base, tris, raw: [...raw] });
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
      expect(r.check.collisions).toBe(0);
      for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.kind === 'pocket' || x.kind === 'finish')) {
        const f = feeds(o.lines);
        f.forEach(([a, b], i) => {
          const p = f[i - 1];
          const back = !!p && Math.hypot(...([0, 1, 2] as const).map((k) => a[k] - p[1][k])) < 1e-6 && Math.hypot(...([0, 1, 2] as const).map((k) => b[k] - p[0][k])) < 1e-6;
          expect(back, `${o.name}: back over a cut at feed to ${b.map((v) => v.toFixed(3))}`).toBe(false);
        });
      }
    }
  }, 300_000);
});

describe('fewer points', () => {
  const near = (p: P2, a: P2, b: P2) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const off = (orig: P2[], out: P2[], closed: boolean) => {
    const segs = out.map((p, i) => [p, out[i + 1] ?? (closed ? out[0] : p)] as [P2, P2]);
    return Math.max(...orig.map((p) => Math.min(...segs.map(([a, b]) => near(p, a, b)))));
  };

  it('keeps every point of a path within the tolerance of the path written, its ends and a loop’s start', () => {
    // A circle of 2,000 points (Clipper's arcs), a straight run with micro-steps, an L.
    const circle = Array.from({ length: 2000 }, (_, i) => [10 * Math.cos((i * Math.PI) / 1000), 10 * Math.sin((i * Math.PI) / 1000)] as P2);
    const c = simplify(circle, 0.005, true);
    expect(c.length).toBeLessThan(200);
    expect(c[0]).toEqual(circle[0]);
    expect(off(circle, c, true)).toBeLessThanOrEqual(0.005 + 1e-9);
    const run = Array.from({ length: 101 }, (_, i) => [i * 0.1, i % 2 ? 0.001 : 0] as P2);
    expect(simplify(run, 0.005, false)).toEqual([run[0], run[100]]);
    const L: P2[] = [[0, 0], [5, 0], [5, 0.004], [5, 5]];
    const l = simplify(L, 0.005, false);
    expect(l).toEqual([[0, 0], [5, 0], [5, 5]]);
    expect(simplify([[0, 0], [1, 1]], 0.005, false)).toEqual([[0, 0], [1, 1]]);
  });

  it('writes a finely faceted round wall with as few points as keep it within 0.005 mm (roughing), not every facet', () => {
    // A Ø30 x 12 cylinder of 1,000 facets (a 3D model's round faces).
    const N = 1000;
    const p = (i: number, z: number) => [15 + 15 * Math.cos((2 * Math.PI * i) / N), 15 + 15 * Math.sin((2 * Math.PI * i) / N), z];
    const t: number[] = [];
    for (let i = 0; i < N; i++) t.push(15, 15, 12, ...p(i, 12), ...p(i + 1, 12), 15, 15, 0, ...p(i + 1, 0), ...p(i, 0), ...p(i, 0), ...p(i + 1, 0), ...p(i + 1, 12), ...p(i, 0), ...p(i + 1, 12), ...p(i, 12));
    const r = camProgram({ ...base, tris: new Float32Array(t), raw: [34, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // The longest run of moves at one height in a roughing op: one ring round the cylinder.
    let most = 0;
    for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.name.startsWith('FRAESEN'))) {
      let run = 0;
      for (const [a, b] of feeds(o.lines)) {
        run = Math.abs(a[2] - b[2]) < 1e-9 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0 ? run + 1 : 0;
        most = Math.max(most, run);
      }
    }
    expect(most).toBeGreaterThan(50);
    expect(most).toBeLessThan(400);
    // Its rings written as whole circles (G02/G03 back to the start, as the shop does), the same on a FANUC.
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    expect(tp.moves.filter((m) => m.kind === 'feed' && m.points.length > 2 && Math.hypot(m.points[0][0] - m.points.at(-1)![0], m.points[0][1] - m.points.at(-1)![1]) < 1e-6).length).toBeGreaterThan(0);
    const fanuc = parseToolpath(forMachine(r.code, 'FANUC-1', 'O0001.NC'), speedsFor('FANUC'));
    const length = (t: typeof tp) => t.moves.filter((m) => m.kind === 'feed').reduce((a, m) => a + m.length, 0);
    expect(length(fanuc)).toBeCloseTo(length(tp), 1);
  }, 300_000);
});
