import { detectMaterial } from './gcodeProcessor';
import { partSizes } from './setups';

/** How the part is drawn in 3D, from the material its program names. */
export type PartLook = 'plain' | 'alu' | 'steel' | 'brass' | 'pom' | 'fh' | 'fhThin' | 'pcgf';

/**
 * The material in the program header: POM (black plastic), FH (layered wood, white top; under 10 mm
 * thick it is all pressed wood, no white top), PC GF (glass-filled polycarbonate), MS (brass), ALU,
 * steel; else plain.
 */
export function partLook(code: string): PartLook {
  const lines = code.split('\n').slice(0, 15);
  const head = lines.join('\n').toUpperCase();
  if (/\bPC[\s-]?GF\d*\b/.test(head)) return 'pcgf';
  const m = detectMaterial(code);
  if (m === 'POM') return 'pom';
  if (m === 'FH') {
    const size = partSizes(lines).finished;
    // A side written 0 is a typo in the header, not a thin plate.
    return size && Math.min(...size.filter((v) => v > 0)) < 10 ? 'fhThin' : 'fh';
  }
  if (m === 'ALU') return 'alu';
  if (m) return 'plain';
  if (/\b(MS|MS58|CUZN\w*|MESSING|BRASS)\b/.test(head)) return 'brass';
  if (/\b(STAHL|STEEL|C45|S235|S355|42CRMO4|1\.\d{4})\b/.test(head)) return 'steel';
  return 'plain';
}
