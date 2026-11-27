import { describe, expect, it } from 'vitest';
import { analyzeGCode } from '../src/lib/gcodeProcessor';
import type { Tool } from '../src/types';

// A033: a reamer is its own type. A program's reamer call is never given a drill of the same Ø, and a reamer in the
// machine is never given to a drilling call.
const program = (comment: string) => ['%', 'O1000', 'N10 T7 M6', `N11 (${comment})`, 'N20 G0 X0. Y0.', 'N30 G81 Z-12. R1. F100', 'N40 M30', '%'].join('\n');
const drill: Tool = { id: 'd', number: 3, category: 'foret', description: 'SB_09.00_051_000_KS', diameter: 9, length: 51 };
const reamer: Tool = { id: 'r', number: 4, category: 'alesoir', description: 'RA_09.00_051_000_KS', diameter: 9, length: 51 };
const matched = (comment: string, tools: Tool[]) => analyzeGCode(program(comment), tools, 'HAAS~tr~HAAS-K').blocks[0].matchedTool?.id ?? null;

describe('reamers in the remapper', () => {
  it('gives a reamer call the reamer, never the drill of its Ø', () => {
    expect(matched('9 H7 REIBAHLE / RA_09.00_051_000_KS', [drill, reamer])).toBe('r');
    expect(matched('9 H7 REIBAHLE / RA_09.00_051_000_KS', [drill])).toBeNull();
  });

  it('gives a drilling call the drill, never the reamer of its Ø', () => {
    expect(matched('9MM BOHRER / SB_09.00_051_000_KS', [reamer, drill])).toBe('d');
    expect(matched('9MM BOHRER / SB_09.00_051_000_KS', [reamer])).toBeNull();
  });
});

// A tool of the tool database for another material (stainless only) is marked so: the remapper prefers a tool marked
// for the program's material, then an unmarked one, and only then it.
describe('material marks from the tool database', () => {
  const pom = ['%', 'O1000', '(MATERIAL POM)', 'N10 T7 M6', 'N11 (3.3MM BOHRER / SB_03.30_041_000_KS)', 'N20 G0 X0. Y0.', 'N30 G81 Z-12. R1. F100', 'N40 M30', '%'].join('\n');
  const pick = (tools: Tool[]) => analyzeGCode(pom, tools, 'HAAS~tr~HAAS-K').blocks[0].matchedTool?.id ?? null;
  const inox: Tool = { id: 'inox', number: 1, category: 'foret', description: 'SB_03.30_041_000_VAHS', diameter: 3.3, length: 41, materials: ['INOX'] };
  const plain: Tool = { id: 'plain', number: 2, category: 'foret', description: 'DRILL', diameter: 3.3, length: 41 };
  const forPom: Tool = { id: 'pom', number: 3, category: 'foret', description: 'SB_03.30_041_000_KS', diameter: 3.3, length: 41, materials: ['PEEK', 'POM'] };

  it('takes the tool for the material, then an unmarked one, before a tool for another material', () => {
    expect(pick([inox, plain, forPom])).toBe('pom');
    expect(pick([inox, plain])).toBe('plain');
    expect(pick([inox])).toBe('inox');
  });
});
