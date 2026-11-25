import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { heightPart } from './heightPart';

// The designer's spacer in the moving jaw (item 3): 15 mm, the shop's; it moves nothing, the check reads it.
describe('a spacer asked in the moving jaw (Y-)', () => {
  const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
  const input = { tris: plate, material: 'ALU' as const, tools: [], brand: 'HAAS' as const, noNest: true, orient: { side: 'Z+', spin: false }, margins: { lo: [5, 2, 5] as [number, number, number], hi: [5, 2, 2] as [number, number, number] } };
  const g52 = (code: string) => code.split('\n').filter((l) => /G52/.test(l)).map((l) => l.replace(/^N\d+\s*/, ''));
  const made = camProgram(input);

  it('is written once in that clamping, moves no G52, and the program still passes', () => {
    const r = camProgram({ ...input, spacersY: [15] });
    expect(r.setups[0].notes.filter((n) => n === '15 MM ZWISCHENLAGE IN Y-')).toHaveLength(1);
    expect(g52(r.code)).toEqual(g52(made.code));
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.notes.some((n) => n.key === 'stopRefused')).toBe(false);
  }, 300_000);

  it('none asked: none, not even CAM AI’s own; another size: refused (noted)', () => {
    expect(camProgram({ ...input, spacersY: [0] }).setups.flatMap((s) => s.notes).some((n) => /ZWISCHENLAGE IN Y-/.test(n))).toBe(false);
    const r = camProgram({ ...input, spacersY: [20] });
    expect(r.notes.some((n) => n.key === 'stopRefused' && n.setup === 1 && n.cale === 20)).toBe(true);
    expect(r.setups[0].notes.some((n) => /ZWISCHENLAGE IN Y-/.test(n))).toBe(false);
  }, 300_000);
});
