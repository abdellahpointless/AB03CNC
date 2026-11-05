import { describe, expect, it } from 'vitest';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { analyseProgram, TABLE_Z } from '../src/lib/setups';
import { buildInput, carve, materialExtreme } from '../src/lib/stockSim';

/*
 * The shop's real programs, each checked against its drawing: the part the simulation leaves must be
 * the drawn part. A rule that breaks one of them breaks this test. Add every new program + drawing
 * pair here once its simulated part matches the drawing.
 *
 *   size   finished size on the drawing (title block)
 *   turns  how the part lies in each setup (part direction -> machine), as checked against the drawing views
 */
const EXPECTED: Record<string, { size: number[]; turns: string[] }> = {
  'O0091589.X20.txt': { size: [56, 47, 21.5], turns: ['1,0,0,0,1,0,0,0,1', '0,-1,0,-1,0,0,0,0,-1'] },
  'O0107096.X20.txt': { size: [24, 26.5, 10], turns: ['1,0,0,0,1,0,0,0,1', '-1,0,0,0,1,0,0,0,-1'] },
  'O0162207.X20.txt': { size: [100, 100, 50], turns: ['1,0,0,0,1,0,0,0,1', '-1,0,0,0,1,0,0,0,-1', '0,1,0,0,0,1,1,0,0', '-1,0,0,0,0,1,0,1,0'] },
  'O0162220.X20.txt': { size: [150, 100, 50], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '1,0,0,0,0,1,0,-1,0', '-1,0,0,0,0,1,0,1,0', '0,1,0,0,0,1,1,0,0'] },
  // The RAFI written "RAF X+Y-" on the first side: turned 180° around X (not Y), as the drawing shows.
  // Ground plate (FH, 8 mm): setup 3 is "ROTATE ON X, Z+ TO Y-" (English, no degrees), setup 4 "90 GRAD UM Y, Z+ WIRD X+".
  'O0160308.X20.txt': { size: [90, 44, 8], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '1,0,0,0,0,1,0,-1,0', '0,-1,0,0,0,1,-1,0,0'] },
  'O0547.X20.txt': { size: [100, 50, 40], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '1,0,0,0,0,-1,0,1,0'] },
  'O0164578.X20.txt': { size: [100, 50, 30], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1'] },
  'O0169538.X20.txt': { size: [150, 100, 30], turns: ['1,0,0,0,1,0,0,0,1', '-1,0,0,0,1,0,0,0,-1', '-1,0,0,0,0,-1,0,-1,0', '1,0,0,0,0,-1,0,1,0'] },
  'O0170150.X20.txt': { size: [28, 36, 15.5], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1'] },
  'O0170834.X20.txt': { size: [100, 50, 30], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '1,0,0,0,0,-1,0,1,0', '0,-1,0,0,0,-1,1,0,0', '0,1,0,0,0,-1,-1,0,0'] },
  'O0171175.X20.txt': { size: [150, 100, 50], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '0,1,0,0,0,-1,-1,0,0', '1,0,0,0,0,-1,0,1,0', '0,-1,0,0,0,-1,1,0,0', '-1,0,0,0,0,-1,0,-1,0'] },
  'O1036013.C96.txt': { size: [100, 50, 30], turns: ['1,0,0,0,1,0,0,0,1', '0,-1,0,-1,0,0,0,0,-1', '0,-1,0,0,0,-1,1,0,0', '0,-1,0,0,0,-1,1,0,0'] },
  'O1061213.C62.txt': { size: [49, 40, 15], turns: ['1,0,0,0,1,0,0,0,1', '-1,0,0,0,1,0,0,0,-1'] },
  'O1215013.C73.txt': { size: [50, 50, 40], turns: ['1,0,0,0,1,0,0,0,1', '0,1,0,1,0,0,0,0,-1', '1,0,0,0,0,1,0,-1,0'] },
  'O1418013.C73.txt': { size: [50, 50, 40], turns: ['1,0,0,0,1,0,0,0,1', '-1,0,0,0,1,0,0,0,-1', '1,0,0,0,0,-1,0,1,0'] },
  'O1494033.118.txt': { size: [84, 49, 20], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '1,0,0,0,0,1,0,-1,0'] },
  'O2437557.000.txt': { size: [100, 50, 50], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1'] },
  'O2540401.000.txt': { size: [21.5, 18, 24.5], turns: ['1,0,0,0,1,0,0,0,1', '1,0,0,0,-1,0,0,0,-1', '1,0,0,0,0,1,0,-1,0', '-1,0,0,0,0,1,0,1,0'] },
};

const programs = import.meta.glob('./corpus/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('real programs against their drawings', () => {
  it('has an expectation for every stored program', () => {
    expect(Object.keys(programs).map((k) => k.replace('./corpus/', '')).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [file, want] of Object.entries(EXPECTED)) {
    it(file, () => {
      const tp = parseToolpath(programs[`./corpus/${file}`], speedsFor('HAAS'));
      const { setups, part } = analyseProgram(tp, { jawHeight: 45 });
      expect(setups.map((s) => s.orient.join(','))).toEqual(want.turns);
      // The finished part, measured on its exact faces, is the drawn part.
      const input = { ...buildInput(tp, { setups, part })!, maxVoxels: 150_000, surfaceMoves: false };
      const g = carve(input);
      const size = ([0, 1, 2] as const).map((a) => materialExtreme(input, g, input.moves.length, a, 1)! - materialExtreme(input, g, input.moves.length, a, -1)!);
      const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
      sorted(size).forEach((v, i) => expect(Math.abs(v - sorted(want.size)[i])).toBeLessThan(0.1));
      for (const s of setups) {
        // Every clamping stands on the machine table (G54 Z-57), and no tool goes into the jaws (a
        // cale in the way is only a warning: the operator moves it).
        if (s.clamp === 'vise' || s.clamp === 'module') expect(s.floorZ! + tp.setups[s.index].shift![2]).toBeCloseTo(TABLE_Z, 1);
        expect(s.collisions.filter((c) => c.what !== 'cale' && c.what !== 'spacer')).toEqual([]);
      }
    }, 60_000);
  }
});
