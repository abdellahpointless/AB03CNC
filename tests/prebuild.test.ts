import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { buildInput, carve, instant, mesher } from '../src/lib/stockSim';
import { heightPart } from './heightPart';

// The part built ahead at each operation's start (stockSim.worker: prebuild) keeps only the chunks that change from one
// instant to the next and takes the others from before, as the view does while playing. A chunk the mesher calls
// unchanged may still move its surface a little: its refinement also uses the last few moves that passed nearby
// (stockSim: crossing, RECENT), which change with the instant. Measured: under one and a half samples.
describe('the part built ahead', () => {
  it('a chunk not dirty between two operations builds the same at both, within one and a half samples', () => {
    const plate = heightPart(Array.from({ length: 20 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 8 && i < 22 && j >= 6 && j < 14 ? 6 : 10))));
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', noNest: true, orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const input = buildInput(tp, analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT }))!;
    const g = carve({ ...input, maxVoxels: 300_000 }, () => {});
    const m = mesher(g, input);
    const starts = tp.moves.flatMap((mv, i) => (i === 0 || mv.setup !== tp.moves[i - 1].setup || mv.tool !== tp.moves[i - 1].tool ? [instant(i + 1)] : []));
    expect(starts.length).toBeGreaterThan(2);
    const sample = 1.5 * Math.max(...g.step);
    let compared = 0;
    for (let k = 1; k < starts.length; k++) {
      const [a, b] = [starts[k - 1], starts[k]];
      const dirty = new Set(m.dirty(a, b));
      for (let id = 0; id < m.chunks; id++) {
        if (dirty.has(id)) continue;
        const x = m.build(id, a);
        const y = m.build(id, b);
        expect(y.positions.length).toBe(x.positions.length);
        expect(y.cut).toEqual(x.cut);
        let worst = 0;
        for (let q = 0; q < x.positions.length; q++) worst = Math.max(worst, Math.abs(x.positions[q] - y.positions[q]));
        expect(worst).toBeLessThanOrEqual(sample);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  }, 300_000);
});
