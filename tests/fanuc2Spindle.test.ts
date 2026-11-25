import { describe, expect, it } from 'vitest';
import { analyzeGCode, codeOnly, generateRemappedCode, savedProgramFor, simulatorProgramFor } from '../src/lib/gcodeProcessor';
import { forMachine } from '../src/lib/cam/export';
import { defaultToolbox } from '../src/lib/defaultTools';
import { engineMachineId } from '../src/regions';

// Made-up program: spindle speeds on an M03 line, alone on their line and on a G line.
const PROGRAM = [
  '%',
  'O1000',
  'N1 (TEIL TEST / POM / 40X30X10)',
  'N2 T1 M6',
  'N3 (SF_06.00_044_000_ALHS)',
  'N4 G00 G90 G54 X0. Y0. S6000 M03 (S9000 IN A COMMENT)',
  'N5 G43 H1 Z50. M08',
  'N6 S8000',
  'N7 G01 Z-1. F500.',
  'N8 G00 X10. S7000',
  'N9 S4500 M03',
  'N10 M05',
  'N11 G53 Z0',
  'N12 G53 Y0',
  'N13 M30',
  '%',
].join('\n');

const FANUC_2 = engineMachineId('ma', { id: 'FANUC-2', brand: 'FANUC' });
const speeds = (code: string) => code.split('\n').flatMap((l) => [...codeOnly(l).matchAll(/(?<![A-Z])S(\d+)/gi)].map((m) => Number(m[1])));

function remap(machineId: string): string {
  const a = analyzeGCode(PROGRAM, defaultToolbox['FANUC-1']!, machineId);
  return generateRemappedCode(a.lines, a.blocks, {}, machineId).finalCode;
}

describe('FANUC-2: the spindle never over S5000, on every way a program leaves the app', () => {
  const outputs: [string, (machine: string) => string][] = [
    ['Process in the remapper', remap],
    ["CAM AI's Download", (machine) => forMachine(PROGRAM, machine, 'O1000.NC')],
    ['History and Recent codes (a program exported before the rule)', (machine) => savedProgramFor(PROGRAM, machine)],
    ["The simulator's Copy and Download of corrected turns (the remapper's source, not yet processed)", (machine) => simulatorProgramFor(PROGRAM, machine)],
  ];

  it.each(outputs)('%s: S over 5000 becomes S5000, S4500 stays', (_path, out) => {
    const code = out(FANUC_2);
    expect(speeds(code)).toEqual([5000, 5000, 5000, 4500]);
    expect(code).toMatch(/S9000 IN A COMMENT/);
  });

  it.each(outputs)('%s: any other machine keeps its speeds', (_path, out) => {
    for (const machine of ['HAAS-1', 'FANUC-1', engineMachineId('tr', { id: 'FANUC-2', brand: 'FANUC' })]) {
      expect(speeds(out(machine))).toEqual([6000, 8000, 7000, 4500]);
    }
  });
});
