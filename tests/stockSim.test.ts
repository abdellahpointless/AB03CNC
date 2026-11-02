import { describe, expect, it } from 'vitest';
import { carve, eigenSym, instant, KEPT, materialExtreme, mesher, sweeps, thicknessAt, touch, wallThickness, type SimInput } from '../src/lib/stockSim';
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
    const th = wallThickness(g);
    const at = (x: number, y: number, z: number) => thicknessAt(g, th, new Float32Array([x, y, z]))[0];
    expect(Math.abs(at(6.5, 5, -4) - 1)).toBeLessThan(g.step[0] * 1.5);
    expect(at(16, 5, -4)).toBeGreaterThan(5);
  });
});
