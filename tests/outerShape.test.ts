import { describe, expect, it } from 'vitest';
import { fillEnclosed, KEPT, SUB, type Grid } from '../src/lib/stockSim';

// Item 2: the part as it is after an operation, its outer walls only (holes, pockets, through-holes closed).
describe('the outer shape of the part at an instant', () => {
  // 10 x 10 x 10 samples: a block with a through-hole along Z (cut by move 1), a pocket from the top (move 2), a step
  // cut off one outside corner (move 3), and a tunnel along X (move 4).
  const n = 10;
  const removed = new Int32Array(n * n * n).fill(KEPT);
  const at = (i: number, j: number, k: number) => (k * n + j) * n + i;
  for (let k = 0; k < n; k++) for (let j = 4; j < 6; j++) for (let i = 4; i < 6; i++) removed[at(i, j, k)] = 1;
  for (let k = 7; k < n; k++) for (let j = 1; j < 3; j++) for (let i = 1; i < 3; i++) removed[at(i, j, k)] = 2;
  for (let k = 6; k < n; k++) for (let j = 7; j < n; j++) for (let i = 7; i < n; i++) removed[at(i, j, k)] = 3;
  for (let k = 2; k < 4; k++) for (let j = 7; j < 9; j++) for (let i = 0; i < n; i++) removed[at(i, j, k)] = 4;
  const g: Grid = { n: [n, n, n], step: [1, 1, 1], size: 1, origin: [0, 0, 0], removed, share: new Uint16Array(n * n * n).fill(65535) };

  it('closes holes, pockets and tunnels, keeps an outside step open, and leaves the grid as it was', () => {
    const out = fillEnclosed(g, 5 * SUB);
    const solid = (v: number) => out.removed[v] === KEPT || out.removed[v] * SUB >= 5 * SUB;
    expect(solid(at(4, 4, 5))).toBe(true);
    expect(solid(at(1, 1, 9))).toBe(true);
    expect(solid(at(5, 8, 3))).toBe(true);
    expect(solid(at(8, 8, 8))).toBe(false);
    expect(g.removed[at(4, 4, 5)]).toBe(1);
  });

  it('only closes what is cut by then', () => {
    const out = fillEnclosed(g, 2 * SUB);
    // The pocket (move 2) is not cut yet at move 2's start: it stays as the grid has it.
    expect(out.removed[at(1, 1, 9)]).toBe(2);
    expect(out.removed[at(4, 4, 5)]).toBe(KEPT);
  });
});
