import { describe, expect, it } from 'vitest';
import { cornerRadius, cornerTip, sweeps } from '../src/lib/stockSim';

// Corner-radius end mills (bull nose): flat-bottomed, the bottom edge rounded, tangent to the bottom and the side.
describe('a corner-radius end mill in the simulation', () => {
  it('is read from its code or its name, the radius in mm', () => {
    expect(cornerTip('SF_10.00_040_R02_ALHS')).toEqual({ corner: 2 });
    expect(cornerTip('TORUSFRAESER D12 R1,5')).toEqual({ corner: 1.5 });
    expect(cornerTip('SF_10.00_040_000_ALHS')).toBeNull();
    expect(cornerTip('KF_10.00_030_R05_KS')).toBeNull();
  });

  it('has its flat bottom, then the rounded edge, then the full Ø', () => {
    expect(cornerRadius(0, 5, 2)).toBe(3);
    expect(cornerRadius(2, 5, 2)).toBe(5);
    expect(cornerRadius(10, 5, 2)).toBe(5);
    expect(cornerRadius(1, 5, 2)).toBeCloseTo(3 + Math.sqrt(3), 9);
    expect(cornerRadius(-0.1, 5, 2)).toBe(-1);
  });

  it('leaves the corner a flat end mill would cut, and cuts the rest the same', () => {
    // A Ø10 tool along X at Z0: just inside the corner (4.9 mm out, 0.1 mm up) only the flat one cuts.
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [20, 0, 0];
    expect(sweeps(10, 4.9, 0.1, a, b, 5, null)).toBe(true);
    expect(sweeps(10, 4.9, 0.1, a, b, 5, { corner: 2 })).toBe(false);
    expect(sweeps(10, 2.5, 0.01, a, b, 5, { corner: 2 })).toBe(true);
    expect(sweeps(10, 4.9, 3, a, b, 5, { corner: 2 })).toBe(true);
  });
});
