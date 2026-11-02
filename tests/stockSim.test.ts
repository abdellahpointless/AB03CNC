import { describe, expect, it } from 'vitest';
import { carve, drilledHoles, eigenSym, holderHits, holderOf, instant, KEPT, materialExtreme, mesher, sweeps, thicknessAt, touch, wallThickness, type SimInput } from '../src/lib/stockSim';
import { pointAlong, runShares, toolAlong } from '../src/lib/playback';
import type { Move, Vec } from '../src/lib/toolpath';

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

describe('eigenSym', () => {
  it('finds eigenpairs of symmetric matrices (vertex fitting for crisp edges)', () => {
    for (let n = 0; n < 200; n++) {
      const g = Array.from({ length: 9 }, rnd);
      const M = new Array(9).fill(0);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) M[i * 3 + j] += g[k * 3 + i] * g[k * 3 + j];
      const { values, vectors } = eigenSym(M);
      for (let k = 0; k < 3; k++) {
        const e = vectors[k];
        expect(Math.hypot(...e)).toBeCloseTo(1, 9);
        for (let i = 0; i < 3; i++) expect(M[i * 3] * e[0] + M[i * 3 + 1] * e[1] + M[i * 3 + 2] * e[2]).toBeCloseTo(values[k] * e[i], 8);
      }
    }
  });
});

describe('touch: when the tool first reaches a point', () => {
  it('reaches exactly the points the sweep cuts, and no earlier', () => {
    for (const slope of [null, Math.tan(Math.PI / 4)]) {
      for (let n = 0; n < 3000; n++) {
        const a: Vec = [rnd() * 10, rnd() * 10, rnd() * 5];
        const b: Vec = n % 5 === 0 ? [a[0], a[1], a[2] - 4] : [rnd() * 10, rnd() * 10, a[2] + rnd() * 3];
        const p: Vec = [rnd() * 12, rnd() * 12, rnd() * 6];
        const r = 1 + Math.abs(rnd()) * 3;
        const u = touch(p[0], p[1], p[2], a, b, r, slope);
        expect(u >= 0).toBe(sweeps(p[0], p[1], p[2], a, b, r, slope));
        if (u > 0.01) {
          // A little earlier along the move the tool has not reached it yet.
          const e: Vec = [a[0] + (b[0] - a[0]) * (u - 0.01), a[1] + (b[1] - a[1]) * (u - 0.01), a[2] + (b[2] - a[2]) * (u - 0.01)];
          expect(sweeps(p[0], p[1], p[2], a, e, r, slope)).toBe(false);
        }
      }
    }
  });
});

describe('cutting follows the tool along a move', () => {
  // A 6 mm end mill cuts a slot along X through a 40 × 20 × 10 block.
  const input: SimInput = {
    moves: [{ setup: 0, tool: 1, points: [[-5, 10, 5], [45, 10, 5]] }],
    setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
    part: { min: [0, 0, 0], max: [40, 20, 10] },
    tools: [{ tool: 1, radius: 3, slope: null }],
    maxVoxels: 60_000,
  };
  const g = carve(input);
  const sample = (x: number) => {
    const i = Math.min(g.n[0] - 1, Math.floor((x - g.origin[0]) / g.step[0]));
    const j = Math.floor((10 - g.origin[1]) / g.step[1]);
    const k = Math.floor((8 - g.origin[2]) / g.step[2]);
    return (k * g.n[1] + j) * g.n[0] + i;
  };

  it('remembers how far along the move each point was cut', () => {
    const share = (x: number) => g.share[sample(x)] / 65536;
    expect(g.removed[sample(20)]).toBe(0);
    // The tool (radius 3) reaches x along the 50 mm move when its centre is at x - 3.
    for (const x of [5, 20, 35]) expect(share(x)).toBeCloseTo((x - 3 + 5) / 50, 1);
    expect(g.removed[sample(20) + g.n[0] * g.n[1] * 0]).not.toBe(KEPT);
  });

  it('shows the part half way through the move with the slot ending at the tool', () => {
    const m = mesher(g, input);
    // Half way: the tool centre is at x = 20; the slot ends 3 mm further, where the tool's edge is.
    const at = instant(0.5);
    let maxX = -Infinity;
    for (let id = 0; id < m.chunks; id++) {
      const c = m.build(id, at);
      for (let v = 0; v < c.positions.length; v += 3) {
        const [x, y, z] = [c.positions[v], c.positions[v + 1], c.positions[v + 2]];
        // Points on the slot floor (z = 5, inside the slot width).
        if (Math.abs(z - 5) < 0.2 && Math.abs(y - 10) < 1.5 && c.cut[v / 3]) maxX = Math.max(maxX, x);
      }
    }
    expect(maxX).toBeGreaterThan(22);
    expect(maxX).toBeLessThan(23.6);
  });
});

describe('surfaces finished by a pass that skims a little more off', () => {
  it('draws a bore at its final size when a second, wider circle follows the first', () => {
    // A 5 mm end mill plunges, runs a circle of radius 0.3, then one of 0.5 and a lead-out arc
    // (O1494033): the bore is 6.01 mm. The wider circle takes only a thin ring of samples.
    const circle = (rad: number, z: number): Vec[] => Array.from({ length: 73 }, (_, i) => [rad * Math.cos((i / 72) * 2 * Math.PI), rad * Math.sin((i / 72) * 2 * Math.PI), z] as Vec);
    const leadOut: Vec[] = Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * (Math.PI / 2);
      return [0.25 * Math.cos(a) + 0.25, 0.25 * Math.sin(a), -4] as Vec;
    });
    const input: SimInput = {
      moves: [
        { setup: 0, tool: 5, points: [[0.3, 0, 2], [0.3, 0, -4]] },
        { setup: 0, tool: 5, points: circle(0.3, -4) },
        { setup: 0, tool: 5, points: circle(0.5, -4) },
        { setup: 0, tool: 5, points: leadOut },
        // The program goes on elsewhere: the bore is no longer among the last moves.
        ...Array.from({ length: 30 }, (_, i) => ({ setup: 0, tool: 5, points: [[20 + i, 20, -1], [21 + i, 20, -1]] as Vec[] })),
      ],
      setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
      part: { min: [-6, -6, -6], max: [6, 6, 0] },
      tools: [{ tool: 5, radius: 2.5, slope: null }],
      maxVoxels: 15_000,
    };
    const g = carve(input);
    const m = mesher(g, input);
    let worst = 0;
    for (let id = 0; id < m.chunks; id++) {
      const c = m.build(id, instant(input.moves.length));
      for (let v = 0; v < c.positions.length; v += 3) {
        const [x, y, z] = [c.positions[v], c.positions[v + 1], c.positions[v + 2]];
        const r = Math.hypot(x, y);
        // Wall vertices below the rim and above the floor.
        if (z < -0.5 && z > -3.5 && r > 2 && r < 4) worst = Math.max(worst, Math.abs(r - 3));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });
});

describe('playback', () => {
  const pts: Vec[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0]];
  const run = runShares(pts);

  it('places the tool along the path by length', () => {
    expect(run[1]).toBeCloseTo(0.5);
    expect(pointAlong(pts, run, 0.25).p).toEqual([5, 0, 0]);
    expect(pointAlong(pts, run, 0.75).p).toEqual([10, 5, 0]);
    expect(pointAlong(pts, run, 0.75).done).toBe(1);
  });

  it('drills down, then comes back up', () => {
    const drill: Move = { kind: 'drill', tool: 1, line: 0, points: [[0, 0, 2]], depth: -8, seconds: 4, length: 10, setup: 0 };
    const path: Vec[] = [[0, 0, 2], [0, 0, -8]];
    const r = runShares(path);
    expect(toolAlong(drill, path, r, 0.4).p[2]).toBeCloseTo(-3);
    expect(toolAlong(drill, path, r, 0.8).p[2]).toBeCloseTo(-8);
    expect(toolAlong(drill, path, r, 0.8).cut).toBe(1);
    expect(toolAlong(drill, path, r, 1).p[2]).toBeCloseTo(2);
  });
});

describe('the real face of the part between setups', () => {
  it('is where the deepest pass went, not the first pass that reached a sample (face-mill layers)', () => {
    // Three face-mill layers on a coarse grid: the last one (Z0) never takes a sample first.
    const passes = [3.333, 1.667, 0].map((z) => ({ setup: 0, tool: 1, points: [[-40, 10, z], [80, 10, z]] as Vec[] }));
    const input: SimInput = {
      moves: passes,
      setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
      part: { min: [0, 0, -10.2], max: [40, 20, 3] },
      tools: [{ tool: 1, radius: 30, slope: null }],
      maxVoxels: 1000,
    };
    const g = carve(input);
    // The case that went wrong: no sample lies between Z0 and the 1.667 layer.
    const centres = Array.from({ length: g.n[2] }, (_, k) => g.origin[2] + (k + 0.5) * g.step[2]);
    expect(centres.some((z) => z >= 0 && z < 1.667)).toBe(false);
    expect(materialExtreme(input, g, passes.length, 2, 1)).toBeCloseTo(0, 2);
  });
});

describe('holes from pure plunges', () => {
  it('finds each plunged hole once at the tool Ø, and drops one a bigger tool opened up', () => {
    // 20 x 20 x 10 block, top at Z0. A 3 mm drill (118°) pecks twice at (5,5); a 6 mm end mill
    // plunges 4 deep at (15,15); a 2 mm mill plunges at (15,15) too (inside the 6 mm hole: gone);
    // a side move at Y 5 is not a hole.
    const input: SimInput = {
      moves: [
        { setup: 0, tool: 1, points: [[5, 5, 2], [5, 5, -3]] },
        { setup: 0, tool: 1, points: [[5, 5, -3], [5, 5, -8]] },
        { setup: 0, tool: 2, points: [[15, 15, 2], [15, 15, -4]] },
        { setup: 0, tool: 3, points: [[15, 15, 2], [15, 15, -3]] },
        { setup: 0, tool: 2, points: [[0, 15, -1], [10, 15, -1]] },
      ],
      setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
      part: { min: [0, 0, -10], max: [20, 20, 0] },
      tools: [{ tool: 1, radius: 1.5, slope: Math.tan((59 * Math.PI) / 180) }, { tool: 2, radius: 3, slope: null }, { tool: 3, radius: 1, slope: null }],
      maxVoxels: 300_000,
    };
    const g = carve(input);
    const holes = drilledHoles(input, g, input.moves.length);
    expect(holes.map((h) => [h.tool, h.r])).toEqual([[1, 1.5], [2, 3]]);
    const [drill, mill] = holes;
    expect(drill.top[0]).toBeCloseTo(5, 6);
    // The rims exactly on the top face (the side cut only touches the mill's hole on 3 of 8 sides).
    expect(drill.top[2]).toBeCloseTo(0, 6);
    expect(mill.top[2]).toBeCloseTo(0, 6);
    // Full Ø down to where the 118° point starts: 8 - 1.5 / tan 59° = 7.1 deep.
    expect(drill.bottom[2]).toBeCloseTo(-8 + 1.5 / Math.tan((59 * Math.PI) / 180), 1);
    expect(mill.bottom[2]).toBeCloseTo(-4, 6);
    // Before the mill plunged: only the drilled hole.
    expect(drilledHoles(input, g, 2).length).toBe(1);
  });
});

describe('bores from circles and helixes', () => {
  // A circle or helix as a polyline (start angle a0, turns, from z0 to z1).
  const arc = (cx: number, cy: number, r: number, a0: number, turns: number, z0: number, z1: number): Vec[] => {
    const n = Math.ceil(turns * 64);
    return Array.from({ length: n + 1 }, (_, i) => {
      const f = i / n;
      const a = a0 + f * turns * Math.PI * 2;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a), z0 + (z1 - z0) * f] as Vec;
    });
  };
  it('finds a helix bore and a two-half circle bore at circle + tool Ø, not a boss or a part arc', () => {
    // 60 x 30 x 15 block, top Z0, a 6 mm end mill.
    const input: SimInput = {
      moves: [
        // Helix down 3 turns at (10,15) in one move, path radius 2, and a last circle at the bottom: a Ø10 bore 9 deep.
        { setup: 0, tool: 1, points: arc(10, 15, 2, 0, 3, 0, -9) },
        { setup: 0, tool: 1, points: arc(10, 15, 2, 0, 1, -9, -9) },
        // Plunge at (30,15), then two half circles of radius 2.5 at -6: a Ø11 bore 6 deep.
        { setup: 0, tool: 1, points: [[30, 15, 1], [30, 15, -6]] },
        { setup: 0, tool: 1, points: arc(30, 15, 2.5, 0, 0.5, -6, -6) },
        { setup: 0, tool: 1, points: arc(30, 15, 2.5, Math.PI, 0.5, -6, -6) },
        // Round the outside of a Ø8 boss at (50,15): a circle of radius 7 at -5 (the middle stays).
        { setup: 0, tool: 1, points: arc(50, 15, 7, 0, 1, -5, -5) },
        // The same bore roughed (path radius 2) then finished 0.2 larger: one Ø10.4 bore, at (40,25).
        { setup: 0, tool: 1, points: arc(40, 25, 2, 0, 1, -4, -4) },
        { setup: 0, tool: 1, points: arc(40, 25, 2.2, 0, 1, -4, -4) },
        // A quarter arc: not a hole.
        { setup: 0, tool: 1, points: arc(10, 5, 3, 0, 0.25, -2, -2) },
      ],
      setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
      part: { min: [0, 0, -15], max: [60, 30, 0] },
      tools: [{ tool: 1, radius: 3, slope: null }],
      maxVoxels: 400_000,
    };
    const g = carve(input);
    const holes = drilledHoles(input, g, input.moves.length);
    const bores = holes.filter((h) => h.r > 3).map((h) => [h.top[0], h.r * 2, Math.round(h.top[2] - h.bottom[2])]);
    expect(bores).toEqual([[10, 10, 9], [30, 11, 6], [40, 10.4, 4]].map(([x, d, depth]) => [expect.closeTo(x, 6), expect.closeTo(d, 6), depth]));
    // The plunge at (30,15) is inside the Ø11 bore: no Ø6 hole of its own.
    expect(holes.filter((h) => h.r === 3)).toEqual([]);
  });
});

describe('tool holders against the part', () => {
  // 60 x 40 x 30 block, top at Z0. Tool 1: Ø6, 10 mm long (holder Ø20 from 10 mm above the tip).
  // Tool 2: Ø40 face mill, 50 long. Tool 3: no length stated.
  const base = (moves: SimInput['moves']): SimInput => ({
    moves,
    setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
    part: { min: [0, 0, -30], max: [60, 40, 0] },
    tools: [{ tool: 1, radius: 3, slope: null }, { tool: 2, radius: 20, slope: null }, { tool: 3, radius: 3, slope: null }],
    maxVoxels: 300_000,
  });
  const lengths = new Map<number | null, number>([[1, 10], [2, 50]]);
  const run = (input: SimInput) => holderHits(input, carve(input), input.moves.map((m) => m.points), input.moves.map((m) => lengths.get(m.tool)));

  it('finds a holder going into the part, about how deep, at that move', () => {
    // Tool 1 plunges 15 deep at (20,20): its holder ends 5 mm inside the material.
    const hits = run(base([{ setup: 0, tool: 1, points: [[20, 20, 5], [20, 20, -15]] }]));
    expect(hits.length).toBe(1);
    expect(hits[0].move).toBe(0);
    expect(hits[0].depth).toBeGreaterThan(4);
    expect(hits[0].depth).toBeLessThan(5.6);
    expect(holderOf(6).radius).toBe(10);
  });

  it('no hit where earlier moves cleared room for the holder, nor for a tool without a length', () => {
    // The face mill clears a Ø40+ pocket 15 deep first; then tool 1 plunges in its middle.
    const pocket = [{ setup: 0, tool: 2, points: [[20, 20, 5], [20, 20, -15]] as Vec[] }];
    expect(run(base([...pocket, { setup: 0, tool: 1, points: [[20, 20, 5], [20, 20, -15]] }]))).toEqual([]);
    // The same plunge before the pocket is cut does hit.
    expect(run(base([{ setup: 0, tool: 1, points: [[20, 20, 5], [20, 20, -15]] }, ...pocket])).length).toBe(1);
    expect(run(base([{ setup: 0, tool: 3, points: [[20, 20, 5], [20, 20, -15]] }]))).toEqual([]);
  });
});

describe('weak spots: wall thickness of the finished part', () => {
  it('finds the 1 mm wall left between two slots, and thick material elsewhere', () => {
    // Two slots 8 deep in a 20 x 10 x 10 block, a 4 mm end mill: they leave a 1 mm wall at X 6..7.
    const slot = (x: number) => ({ setup: 0, tool: 1, points: [[x, -5, -8], [x, 15, -8]] as Vec[] });
    const input: SimInput = {
      moves: [slot(4), slot(9)],
      setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
      part: { min: [0, 0, -10], max: [20, 10, 0] },
      tools: [{ tool: 1, radius: 2, slope: null }],
      maxVoxels: 200_000,
    };
    const g = carve(input);
    const th = wallThickness(g, input);
    const at = (x: number, y: number, z: number) => thicknessAt(g, th, new Float32Array([x, y, z]))[0];
    // Measured on the exact faces: 1 mm to a tenth, though a sample step is ~0.4 mm here.
    expect(at(6.5, 5, -4)).toBeCloseTo(1, 1);
    expect(at(16, 5, -4)).toBeGreaterThan(5);
    // A 0.4 mm wall (slots 4.4 mm apart) reads 0.4, not a whole sample step.
    const thin = { ...input, moves: [slot(4), slot(8.4)] };
    const g2 = carve(thin);
    expect(thicknessAt(g2, wallThickness(g2, thin), new Float32Array([6.2, 5, -4]))[0]).toBeCloseTo(0.4, 1);
  });
});
