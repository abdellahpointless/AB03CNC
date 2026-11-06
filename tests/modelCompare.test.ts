import { describe, expect, it } from 'vitest';
import pdfUrl from './models/O2504411.pdf?inline';
import program from './models/O2504411.000.txt?raw';
import { readModel } from '../src/lib/model';
import { layModel, placeModel } from '../src/lib/modelCompare';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { buildInput } from '../src/lib/stockSim';

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const size = (t: Float32Array) =>
  [0, 1, 2].map((k) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = k; i < t.length; i += 3) (lo = Math.min(lo, t[i])), (hi = Math.max(hi, t[i]));
    return hi - lo;
  });

describe('the real part laid on the simulated part', async () => {
  const tp = parseToolpath(program, speedsFor('HAAS'));
  const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
  const input = buildInput(tp, an)!;
  const tris = await readModel(bytes(pdfUrl));

  it('lies where the simulation made it (O2504411 and its 3D PDF)', () => {
    const laid = layModel(tris, input, an.setups);
    if ('mismatch' in laid) throw new Error('no fit');
    expect(laid.overlap).toBeGreaterThan(0.95);
    size(placeModel(tris, laid.R, laid.t)).forEach((v, k) => expect(Math.abs(v - laid.size[k])).toBeLessThan(1.5));
  }, 60_000);

  it('says it is not this part when the size differs', () => {
    const big = tris.map((v) => v * 1.3);
    expect(layModel(big, input, an.setups)).toHaveProperty('mismatch');
  }, 60_000);
});
