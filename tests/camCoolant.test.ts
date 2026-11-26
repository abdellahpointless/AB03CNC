import { describe, expect, it } from 'vitest';
import { forMachine } from '../src/lib/cam/export';
import { camProgram } from '../src/lib/cam/program';
import { coolingOf } from '../src/regions';
import { heightPart } from './heightPart';

// You: the coolant is the machine's, never asked per tool. HAAS-1, HAAS-5, FANUC-1 and FANUC-2 run coolant;
// HAAS-2 and HAAS-4 blow air (the Moroccan standard).

// A 40 x 30 x 12 plate with a 20 x 12 pocket 6 deep: a face mill and end mills, several tool changes.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
const base = { tris: plate, material: 'ALU' as const, tools: [], brand: 'HAAS', raw: [44, 34, 19] as [number, number, number], orient: { side: 'Z+', spin: false }, noNest: true };
/** The coolant word on each tool's first line (G43 to the safe height). */
const words = (code: string) => code.split('\n').filter((l) => /G43 H\d+ Z/.test(l)).map((l) => (/M83/.test(l) ? 'air' : /M0?8(?!\d)/.test(l) ? 'flood' : 'none'));

describe('coolant by machine', () => {
  it('writes the machine\'s coolant on every tool, whatever was asked for one tool', () => {
    const r0 = camProgram(base);
    const code = r0.setups[0].ops[0].tool.code;
    // A tool once set to air, another to off (old programs): the machine decides all the same.
    const cuts = { [code]: { coolant: 'off' as const } };
    const flood = camProgram({ ...base, coolant: 'flood', cuts });
    const air = camProgram({ ...base, coolant: 'air', cuts });
    expect(words(flood.code).length).toBeGreaterThan(2);
    expect(new Set(words(flood.code))).toEqual(new Set(['flood']));
    expect(new Set(words(air.code))).toEqual(new Set(['air']));
    // Nothing asked: coolant (the planner's default).
    expect(new Set(words(r0.code))).toEqual(new Set(['flood']));
  }, 600_000);

  it('gives each Moroccan machine its own cooling in the downloaded program', () => {
    expect(['HAAS-1', 'HAAS-5', 'FANUC-1', 'FANUC-2'].map(coolingOf)).toEqual(['lubricant', 'lubricant', 'lubricant', 'lubricant']);
    expect(['HAAS-2', 'HAAS-4'].map(coolingOf)).toEqual(['air', 'air']);
    for (const id of ['HAAS-1', 'HAAS-5', 'FANUC-1', 'FANUC-2', 'HAAS-2', 'HAAS-4']) {
      const air = coolingOf(id) === 'air';
      const r = camProgram({ ...base, coolant: air ? 'air' : 'flood' });
      const out = forMachine(r.code, id, 'TEIL.NC', 'ALU');
      const code = out.split('\n').map((l) => l.replace(/\([^)]*\)/g, ''));
      const on = code.filter((l) => /(?<![A-Z0-9.])M0?8(?![0-9.])/.test(l)).length;
      const jet = code.filter((l) => /M83/.test(l)).length;
      if (air) {
        expect(on, id).toBe(0);
        expect(jet, id).toBeGreaterThan(2);
      } else {
        expect(on, id).toBeGreaterThan(2);
        expect(jet, id).toBe(0);
      }
    }
  }, 600_000);
});
