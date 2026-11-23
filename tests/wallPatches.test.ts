import { describe, expect, it } from 'vitest';
import { wallPatches } from '../src/components/CamPartView';
import { heightPart, plateWithHoles } from './heightPart';

describe('the walls to pick for finishing (wallPatches)', () => {
  it('a flat wall is one patch, a corner splits two, a round hole is one', () => {
    // 60 x 40 x 10 with a 20 x 10 pocket: 4 outside walls and 4 pocket walls, the floors none.
    const plate = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 60 }, (_, i) => (i >= 20 && i < 40 && j >= 15 && j < 25 ? 4 : 10))));
    const p = wallPatches(plate, [0, 0, 1]);
    expect(p.patches).toHaveLength(8);
    // A hole's 48 facets turn 7.5° each: one wall, besides the 4 outside ones.
    const holed = wallPatches(plateWithHoles(40, 30, 10, [{ c: [20, 15], d: 11 }]), [0, 0, 1]);
    expect(holed.patches).toHaveLength(5);
    expect(holed.patches.map((w) => w.length).sort((a, b) => b - a)[0]).toBe(96);
    // Lying on its side (up along Y), the plate's top and bottom are walls; the pocket's floor too.
    expect(wallPatches(plate, [0, 1, 0]).patches.length).toBeGreaterThan(0);
  });
});
