/*
 * CAM AI's program (HAAS code) as one machine gets it from Download: the machine rules Send applies
 * through the remapper (gcodeProcessor generateRemappedCode), so both ways give the machine the same
 * program. FANUC-2 runs HAAS code with G49 on each tool change, at most S5000, 2 mm pecks in aluminium
 * and brass, and FANUC numbers; each HAAS its air or coolant code; FH pecks at most 5 mm; the other
 * FANUCs (the Robodrills) the FANUC dialect.
 */
import { addG49AfterM6, applyMachineCoolant, detectMaterial, fanuc2Limits, fanucNumbers, fhPecks, isAluOrBrass } from '../gcodeProcessor';
import { convertHaasToFanuc } from '../haasToFanucConverter';

/** `machineId`: the engine's id (regions.ts engineMachineId); `fileName`: the program's, for the FANUC O line. */
export function forMachine(code: string, machineId: string, fileName: string): string {
  const fanuc2 = machineId === 'FANUC-2';
  let lines = code.split('\n');
  if (fanuc2) lines = fanuc2Limits(addG49AfterM6(lines), isAluOrBrass(code));
  lines = applyMachineCoolant(lines, machineId);
  if (detectMaterial(code) === 'FH') lines = fhPecks(lines);
  if (fanuc2) lines = fanucNumbers(lines);
  const out = lines.join('\n');
  return machineId.toUpperCase().startsWith('FANUC') && !fanuc2 ? convertHaasToFanuc(out, fileName).fanucCode : out;
}
