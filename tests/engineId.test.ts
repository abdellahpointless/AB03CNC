import { describe, expect, it } from 'vitest';
import { analyzeGCode, generateRemappedCode } from '../src/lib/gcodeProcessor';
import { engineMachineId, maxPocketsFor } from '../src/regions';
import type { Tool } from '../src/types';

const PROGRAM = ['%', 'O1000', 'N10 T1 M6', 'N11 (PUNTA D6 / POINTEUR)', 'N20 G90 G54 G0 X0. Y0.', 'N30 T2 M6', 'N31 (FRAISE EBAUCHE D16)', 'N40 G0 Z50.', 'N50 M30', '%'].join('\n');
const FANUC_TOOLS: Tool[] = [
  { id: 'a', number: 250550, pocket: 4, category: 'pointeur', description: 'Punta D6', diameter: 6, length: 40 },
  { id: 'b', number: 161600, pocket: 1, category: 'fraise ebauche', description: 'Kaba freze D16', diameter: 16, length: 45 },
  { id: 'c', number: 230200, pocket: 2, category: 'foret', description: 'Matkap D4.2', diameter: 4.2, length: 55 },
];

function run(machineId: string, tools: Tool[], program = PROGRAM): string {
  const a = analyzeGCode(program, tools, machineId);
  return generateRemappedCode(a.lines, a.blocks, {}, machineId).finalCode;
}

describe('machine identity given to the G-code engine', () => {
  it('keeps the original Moroccan machine ids unchanged', () => {
    for (const id of ['HAAS-1', 'HAAS-2', 'FANUC-1', 'FANUC-2', 'DMG-1']) {
      expect(engineMachineId('ma', { id, brand: id.startsWith('FANUC') ? 'FANUC' : id.startsWith('HAAS') ? 'HAAS' : 'DMG MORI' })).toBe(id);
    }
  });

  it('tags every other machine with its brand so Moroccan machine rules never match', () => {
    expect(engineMachineId('tr', { id: 'HAAS-1', brand: 'HAAS' })).toBe('HAAS~tr~HAAS-1');
    expect(engineMachineId('tr', { id: 'FANUC-2', brand: 'FANUC' })).toBe('FANUC~tr~FANUC-2');
    expect(engineMachineId('ma', { id: 'ROBODRILL-3', brand: 'FANUC' })).toBe('FANUC~ma~ROBODRILL-3');
    expect(engineMachineId('tr', { id: 'X', brand: 'DMG MORI' })).toBe('OTHER~tr~X');
  });

  it('a Turkish FANUC machine produces exactly the same program as Moroccan FANUC-1', () => {
    const tr = run(engineMachineId('tr', { id: 'ROBODRILL-1', brand: 'FANUC' }), FANUC_TOOLS);
    expect(tr).toBe(run('FANUC-1', FANUC_TOOLS));
  });

  it('the FANUC-2-only G49 rule does not fire for a Turkish machine named FANUC-2', () => {
    const moroccan = run('FANUC-2', FANUC_TOOLS);
    const turkish = run(engineMachineId('tr', { id: 'FANUC-2', brand: 'FANUC' }), FANUC_TOOLS);
    expect(moroccan).toMatch(/G49/);
    expect(turkish).not.toMatch(/G49/);
  });

  it('pocket limits match the old hard-coded values for Morocco', () => {
    expect(maxPocketsFor({ brand: 'HAAS', pockets: 41 })).toBe(41); // HAAS-1
    expect(maxPocketsFor({ brand: 'FANUC', pockets: null })).toBe(21);
    expect(maxPocketsFor({ brand: 'HAAS', pockets: null })).toBe(99);
    expect(maxPocketsFor({ brand: 'DMG MORI', pockets: null })).toBe(99);
  });
});
