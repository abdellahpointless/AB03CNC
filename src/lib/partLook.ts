import { detectMaterial } from './gcodeProcessor';

/** How the part is drawn in 3D, from the material its program names. */
export type PartLook = 'plain' | 'alu' | 'steel' | 'brass' | 'pom' | 'fh';

/** The material in the program header: POM (black plastic), FH (layered wood, white top), MS (brass), ALU, steel; else plain. */
export function partLook(code: string): PartLook {
  const m = detectMaterial(code);
  if (m === 'POM') return 'pom';
  if (m === 'FH') return 'fh';
  if (m === 'ALU') return 'alu';
  if (m) return 'plain';
  const head = code.split('\n').slice(0, 15).join('\n').toUpperCase();
  if (/\b(MS|MS58|CUZN\w*|MESSING|BRASS)\b/.test(head)) return 'brass';
  if (/\b(STAHL|STEEL|C45|S235|S355|42CRMO4|1\.\d{4})\b/.test(head)) return 'steel';
  return 'plain';
}
