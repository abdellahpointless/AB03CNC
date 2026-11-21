import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { applyMachineCoolant } from '../src/lib/gcodeProcessor';
import { convertHaasToFanuc } from '../src/lib/haasToFanucConverter';
import { parseToolpath, speedsFor, type Move } from '../src/lib/toolpath';
import { pocketWithHole } from './heightPart';

// What CAM AI's download sends each kind of machine (CamAi.tsx): its own HAAS code with the machine's
// air or coolant code, converted for the FANUC Robodrills, as it is for FANUC-2 (it runs HAAS code).
describe("CAM AI's program as each machine gets it", () => {
  // A plate with a pocket (arcs in its corners) and a hole (drilling cycles).
  const part = pocketWithHole(40, 30, 12, [10, 8, 30, 22], 6, { c: [20, 15], d: 4 });
  const r = camProgram({ tris: part, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true });
  const moved = (ms: Move[]) => ms.filter((m) => m.kind === 'drill' || m.points.some((p) => p.some((v, c) => Math.abs(v - m.points[0][c]) > 1e-9)));
  const geometry = (code: string, brand: string) => moved(parseToolpath(code, speedsFor(brand)).moves).map((m) => ({ kind: m.kind, setup: m.setup, depth: m.depth, points: m.points.map((p) => p.map((v) => Math.round(v * 1000) / 1000)) }));

  it('has arcs and drilling cycles, and the shop’s end', () => {
    expect(r.code).toMatch(/ G0[23] X/);
    expect(r.code).toMatch(/ G98 G8[13] /);
    expect(r.code).toMatch(/G0 G53 G49 Y0 Z0 M89\n.*Gesamt-Bearbeitungszeit =\d+\.\dMIN/);
  }, 600_000);

  it('reads back as the same moves on every machine', () => {
    const own = geometry(r.code, 'HAAS');
    for (const machine of ['HAAS-1', 'HAAS-2', 'HAAS-3', 'FANUC-1', 'FANUC-2']) {
      const cooled = applyMachineCoolant(r.code.split('\n'), machine).join('\n');
      const fanuc = machine.startsWith('FANUC') && machine !== 'FANUC-2';
      const sent = fanuc ? convertHaasToFanuc(cooled, 'O0001.NC').fanucCode : cooled;
      expect(geometry(sent, fanuc ? 'FANUC' : 'HAAS'), machine).toEqual(own);
      // M89 (HAAS through-spindle coolant off) never reaches a Robodrill.
      if (fanuc) expect(sent).not.toMatch(/M89/);
    }
  });
});
