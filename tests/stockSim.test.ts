import { describe, expect, it } from 'vitest';
import { eigenSym } from '../src/lib/stockSim';

describe('eigenSym', () => {
  it('finds eigenpairs of symmetric matrices (vertex fitting for crisp edges)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
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
