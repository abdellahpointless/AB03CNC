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
    expect(r.notes.some((n) => n.key === 'stopRefused' || n.key === 'spacerRefused')).toBe(false);
  }, 300_000);

  it('the stop spacer of a later clamping moves only that clamping, by exactly its thickness along X', () => {
    expect(made.setups.length).toBeGreaterThan(1);
    const r = camProgram({ ...input, stops: [null, 15] });
    const x = (code: string) => g52(code).map((l) => Number(l.match(/X(-?[\d.]+)/)![1]));
    const [was, now] = [x(made.code), x(r.code)];
    expect(now[0]).toBeCloseTo(was[0], 6);
    expect(now[1] - was[1]).toBeCloseTo(15, 6);
    expect(r.setups[0].notes.some((n) => /ZWISCHENLAGE IN X-/.test(n))).toBe(false);
    expect(r.setups[1].notes).toContain('15 MM ZWISCHENLAGE IN X-');
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
  }, 300_000);

  it('takes the moving-jaw spacer in 20 and 50 mm too (the owner: "sure if needed")', () => {
    for (const mm of [20, 50]) {
      const r = camProgram({ ...input, spacersY: [mm] });
      expect(r.setups[0].notes).toContain(`${mm} MM ZWISCHENLAGE IN Y-`);
      expect(g52(r.code)).toEqual(g52(made.code));
      expect(r.check.collisions).toBe(0);
    }
  }, 600_000);

  // The owner: "sometimes in very special cases, keep it an extra option". The part rests on it instead of the fixed
  // jaw: that clamping's G52 Y moves by exactly its thickness toward the operator, nothing else. The check places the
  // jaws round the part, so only this test sees a wrong G52 Y.
  it('a spacer at the fixed jaw (Y+) moves only that clamping, by exactly its thickness along -Y', () => {
    const r = camProgram({ ...input, spacersYp: [null, 15] });
    const y = (code: string) => g52(code).map((l) => Number(l.match(/Y(-?[\d.]+)/)![1]));
    const [was, now] = [y(made.code), y(r.code)];
    expect(now[0]).toBeCloseTo(was[0], 6);
    expect(now[1] - was[1]).toBeCloseTo(-15, 6);
    const xz = (code: string) => g52(code).map((l) => l.replace(/Y-?[\d.]+/, ''));
    expect(xz(r.code)).toEqual(xz(made.code));
    expect(r.setups[1].notes).toContain('15 MM ZWISCHENLAGE IN Y+');
    expect(r.setups[0].notes.some((n) => /IN Y\+/.test(n))).toBe(false);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    // Only the shop's sizes.
    // Said as the fixed jaw's spacer, not the stop's (a review found the stop's words used).
    expect(camProgram({ ...input, spacersYp: [12] }).notes).toContainEqual({ key: 'spacerRefused', setup: 1, cale: 12, side: 'Y+' });
  }, 600_000);

  // "None" forbidding the spacer CAM AI would add itself: tests/camLayouts.test.ts (the boss plate).
  it('none asked: none written; another size: refused (noted)', () => {
    expect(camProgram({ ...input, spacersY: [0] }).setups.flatMap((s) => s.notes).some((n) => /ZWISCHENLAGE IN Y-/.test(n))).toBe(false);
    const r = camProgram({ ...input, spacersY: [12] });
    expect(r.notes).toContainEqual({ key: 'spacerRefused', setup: 1, cale: 12, side: 'Y-' });
    expect(r.setups[0].notes.some((n) => /ZWISCHENLAGE IN Y-/.test(n))).toBe(false);
  }, 300_000);
});
