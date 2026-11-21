/*
 * CAM AI's program (HAAS code) as one machine gets it from Download: the machine rules Send applies
 * through the remapper (gcodeProcessor generateRemappedCode). FANUC-2 runs HAAS code with G49 on each
 * tool change, at most S5000, 2 mm pecks in aluminium and brass, and FANUC numbers; each HAAS its air or
 * coolant code; FH pecks at most 5 mm; the other FANUCs (the Robodrills) the FANUC dialect. Send differs
 * in two things (docs/knowledge/cam-gaps.md, G4): the remapper picks the tools again from the machine's
 * inventory, and reads the material from the program's text (a model named after another material reads
 * as that one); Download keeps CAM AI's tools and takes the material CAM AI cut.
 */
import { addG49AfterM6, applyMachineCoolant, detectMaterial, fanuc2Limits, fanucNumbers, fhPecks, isAluOrBrass } from '../gcodeProcessor';
import { convertHaasToFanuc } from '../haasToFanucConverter';

/**
 * `machineId`: the engine's id (regions.ts engineMachineId); `fileName`: the program's, for the FANUC O line;
 * `material`: CAM AI's (a word in the model's name could make the program's text read as another).
 */
export function forMachine(code: string, machineId: string, fileName: string, material?: string): string {
  const fanuc2 = machineId === 'FANUC-2';
  let lines = code.split('\n');
  if (fanuc2) lines = fanuc2Limits(addG49AfterM6(lines), material ? material === 'ALU' || material === 'MS' : isAluOrBrass(code));
  lines = applyMachineCoolant(lines, machineId);
  if ((material ?? detectMaterial(code)) === 'FH') lines = fhPecks(lines);
  if (fanuc2) lines = fanucNumbers(lines);
  const out = lines.join('\n');
  return machineId.toUpperCase().startsWith('FANUC') && !fanuc2 ? convertHaasToFanuc(out, fileName).fanucCode : out;
}
